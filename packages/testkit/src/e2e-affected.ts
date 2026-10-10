import path from "node:path";
import { type ImpactMap, specsForFile } from "./e2e-impact.js";

/** Specs are named relative to `apps/web/e2e`, as in the impact map. */
export type Selection =
  | { kind: "full"; reason: string }
  | {
      kind: "specs";
      specs: string[];
      because: Record<string, string[]>;
      ignored: string[];
      uncovered: string[];
    }
  | { kind: "none"; ignored: string[]; uncovered: string[] };

/** Files that import a file, keyed by the imported file. Paths are repo-relative. */
export type Importers = ReadonlyMap<string, readonly string[]>;

type Effect =
  | { kind: "full"; reason: string }
  | { kind: "trace"; unreached: "uncovered" | "ignored" };

const full = (reason: string): Effect => ({ kind: "full", reason });
const runtime: Effect = { kind: "trace", unreached: "uncovered" };
const optional: Effect = { kind: "trace", unreached: "ignored" };

const SPEC_FILE = /^apps\/web\/e2e\/([^/]+\.spec\.ts)$/;

/**
 * First match wins. A traced file runs each spec it is, the specs whose recorded
 * coverage includes it, and the specs that reach it through imports. When none
 * does, a runtime file is reported as uncovered and anything else (mobile,
 * desktop, docs, infra) as ignored.
 */
const RULES: ReadonlyArray<readonly [RegExp, Effect]> = [
  [/^apps\/web\/e2e\/(helpers|test)\.ts$/, full("shared e2e helpers changed")],
  [/^apps\/web\/playwright\.config\.ts$/, full("Playwright config changed")],
  [/^apps\/web\/(vite\.config\.ts|lingui\.config\.ts|index\.html)$/, full("web build changed")],
  [/^packages\/testkit\/src\/(cli\/harness|cli\/process|e2e-impact)\.ts$/, full("harness changed")],
  [/^((apps\/(web|api)|packages\/[^/]+)\/)?package\.json$/, full("package manifest changed")],
  [/^(pnpm-lock\.yaml|pnpm-workspace\.yaml|patches\/)/, full("dependencies changed")],
  [/^packages\/db\/prisma\//, full("database schema changed")],
  [/(\.test\.tsx?|\.test-d\.ts|\.md)$/, optional],
  [/^(apps\/web\/(src|public|e2e\/fixtures)|apps\/api\/src|packages\/[^/]+\/src)\//, runtime],
];

function effectOf(file: string): Effect {
  return RULES.find(([pattern]) => pattern.test(file))?.[1] ?? optional;
}

export function selectSpecs(input: {
  changed: readonly string[];
  map: ImpactMap | undefined;
  specsOnDisk: readonly string[];
  importers: Importers;
}): Selection {
  const { changed, map, specsOnDisk, importers } = input;
  if (!map) {
    return {
      kind: "full",
      reason: "no readable impact map; run pnpm test:e2e:impact-map to record one",
    };
  }
  const because = new Map<string, string[]>();
  const select = (spec: string, why: string) =>
    because.set(spec, [...(because.get(spec) ?? []), why]);
  const ignored: string[] = [];
  const uncovered: string[] = [];
  for (const file of [...changed].sort()) {
    const effect = effectOf(file);
    if (effect.kind === "full") return { kind: "full", reason: `${file}: ${effect.reason}` };
    const specs = reachedSpecs(file, map, importers).filter((spec) => specsOnDisk.includes(spec));
    for (const spec of specs) select(spec, file);
    if (specs.length > 0) continue;
    if (effect.unreached === "uncovered") uncovered.push(file);
    else ignored.push(file);
  }
  const mapped = new Set(map.specs);
  for (const spec of specsOnDisk) if (!mapped.has(spec)) select(spec, "not in the impact map");
  if (because.size === 0) return { kind: "none", ignored, uncovered };
  const specs = [...because.keys()].sort();
  return {
    kind: "specs",
    specs,
    because: Object.fromEntries(specs.map((spec) => [spec, because.get(spec)!])),
    ignored,
    uncovered,
  };
}

/** Walk importers up from `file` until each path hits a spec or a file in the map. */
function reachedSpecs(file: string, map: ImpactMap, importers: Importers): string[] {
  const specs = new Set<string>();
  const seen = new Set([file]);
  const queue = [file];
  for (const current of queue) {
    const spec = SPEC_FILE.exec(current)?.[1];
    const recorded = spec ? [spec] : specsForFile(map, current);
    if (recorded) {
      for (const name of recorded) specs.add(name);
      continue;
    }
    for (const importer of importers.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  return [...specs].sort();
}

export type WorkspacePackage = { dir: string; exports: unknown };

const STATIC_IMPORT = /^\s*(?:import|export)(\s+type\b)?[^"';]*?\bfrom\s*["']([^"']+)["']/gm;
const BARE_IMPORT = /^\s*import\s*["']([^"']+)["']/gm;
const CALL_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const SCRIPT_SRC = /<script\b[^>]*\bsrc=["']([^"']+)["']/g;

/** Runtime module specifiers in a source file. Type-only imports are skipped. */
export function importSpecifiers(source: string): string[] {
  const specifiers = [...source.matchAll(STATIC_IMPORT)]
    .filter((match) => !match[1])
    .map((match) => match[2]!);
  for (const pattern of [BARE_IMPORT, CALL_IMPORT, SCRIPT_SRC]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|html)$/;
const PROBE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/**
 * Builds the reverse import graph over `files` (every repo file). Resolves
 * relative imports with extension probing, `.js` written for `.ts`, root paths
 * in HTML against the web app, and `@rakazo/*` through each package's exports.
 */
export function buildImporters(
  files: ReadonlySet<string>,
  read: (file: string) => string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): Importers {
  const probe = (base: string) => {
    const stems = [base, base.replace(/\.jsx?$/, ".ts"), base.replace(/\.jsx?$/, ".tsx")];
    for (const stem of stems) {
      for (const suffix of PROBE_SUFFIXES) {
        if (files.has(stem + suffix)) return stem + suffix;
      }
    }
    return undefined;
  };
  const resolve = (specifier: string, from: string) => {
    const bare = specifier.split("?")[0]!;
    if (bare.startsWith(".")) return probe(path.posix.join(path.posix.dirname(from), bare));
    if (bare.startsWith("/") && from.endsWith(".html")) return probe(`apps/web${bare}`);
    const [scope, name, ...rest] = bare.split("/");
    const workspace = packages.get(`${scope}/${name}`);
    const target = workspace && exportTarget(workspace.exports, rest.join("/"));
    return target ? probe(path.posix.join(workspace.dir, target)) : undefined;
  };
  const importers = new Map<string, string[]>();
  for (const file of files) {
    if (!SOURCE_FILE.test(file)) continue;
    for (const specifier of new Set(importSpecifiers(read(file)))) {
      const target = resolve(specifier, file);
      if (target) importers.set(target, [...(importers.get(target) ?? []), file]);
    }
  }
  return importers;
}

function exportTarget(exports: unknown, subpath: string): string | undefined {
  const key = subpath ? `./${subpath}` : ".";
  if (typeof exports === "string") return key === "." ? exports : undefined;
  if (typeof exports !== "object" || exports === null) return undefined;
  const entries = exports as Record<string, unknown>;
  if (key in entries) return conditionTarget(entries[key]);
  for (const [pattern, value] of Object.entries(entries)) {
    const [prefix, suffix] = pattern.split("*");
    if (suffix === undefined || !key.startsWith(prefix!) || !key.endsWith(suffix)) continue;
    const match = key.slice(prefix!.length, key.length - suffix.length);
    return conditionTarget(value)?.replace("*", match);
  }
  return undefined;
}

function conditionTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const conditions = value as Record<string, unknown>;
  return conditionTarget(conditions.development ?? conditions.import ?? conditions.default);
}
