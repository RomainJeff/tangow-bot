import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ScriptCoverage = {
  url: string;
  functions: readonly { ranges: readonly { startOffset: number; count: number }[] }[];
};

/** What one test touched: its spec (relative to `apps/web/e2e`) and repo files. */
export type ImpactRecord = { spec: string; files: readonly string[] };

/**
 * Committed as `apps/web/e2e/impact-map.json`. Keyed by file so a change to one
 * file's coverage is one changed line. A value is the space-separated specs
 * that ran code in that file, or `*` when every spec did.
 */
export type ImpactMap = { commit: string; specs: string[]; files: Record<string, string> };

export const IMPACT_MAP_PATH = "apps/web/e2e/impact-map.json";
const EVERY_SPEC = "*";

/**
 * A module body runs on import, so counting it would tie every spec to every
 * eagerly imported module. A file counts once any other function in it ran.
 */
export function touchedFiles(
  scripts: readonly ScriptCoverage[],
  toRepoFile: (url: string) => string | undefined,
): string[] {
  const files = new Set<string>();
  for (const script of scripts) {
    const ran = script.functions.some(
      ({ ranges: [range] }) => range && range.startOffset > 0 && range.count > 0,
    );
    const file = ran ? toRepoFile(script.url) : undefined;
    if (file) files.add(file);
  }
  return [...files].sort();
}

export function repoFile(absolute: string, repoRoot: string): string | undefined {
  const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) return undefined;
  if (relative.split("/").includes("node_modules")) return undefined;
  if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) return undefined;
  return relative;
}

export function fileUrlToRepoFile(url: string, repoRoot: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  const parsed = new URL(url);
  parsed.search = "";
  return repoFile(fileURLToPath(parsed), repoRoot);
}

/** Vite dev serves app files from its root and other files under `/@fs/<absolute path>`. */
export function viteUrlToRepoFile(
  url: string,
  origin: string,
  webRoot: string,
  repoRoot: string,
): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.origin !== origin) return undefined;
  const pathname = decodeURIComponent(parsed.pathname);
  if (pathname.startsWith("/@fs/")) return repoFile(pathname.slice("/@fs".length), repoRoot);
  if (pathname.startsWith("/@")) return undefined;
  return repoFile(path.join(webRoot, pathname), repoRoot);
}

/**
 * A page URL that is not a file is an app route, which Vite answers with
 * `index.html`. Recording it lets files only the entry imports, such as global
 * styles, reach the specs that opened the app.
 */
export function viteDocumentToRepoFile(
  url: string,
  origin: string,
  webRoot: string,
  repoRoot: string,
): string | undefined {
  if (!URL.canParse(url) || new URL(url).origin !== origin) return undefined;
  return (
    viteUrlToRepoFile(url, origin, webRoot, repoRoot) ??
    repoFile(path.join(webRoot, "index.html"), repoRoot)
  );
}

export function buildImpactMap(records: readonly ImpactRecord[], commit: string): ImpactMap {
  const filesBySpec = new Map<string, Set<string>>();
  for (const record of records) {
    const files = filesBySpec.get(record.spec) ?? new Set();
    for (const file of record.files) files.add(file);
    filesBySpec.set(record.spec, files);
  }
  const specs = [...filesBySpec.keys()].sort();
  const specsByFile = new Map<string, string[]>();
  for (const spec of specs) {
    for (const file of filesBySpec.get(spec)!) {
      specsByFile.set(file, [...(specsByFile.get(file) ?? []), spec]);
    }
  }
  const files = [...specsByFile]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, list]) => [file, list.length === specs.length ? EVERY_SPEC : list.join(" ")]);
  return { commit, specs, files: Object.fromEntries(files) };
}

export function specsForFile(map: ImpactMap, file: string): string[] | undefined {
  const value = map.files[file];
  if (value === undefined) return undefined;
  return value === EVERY_SPEC ? map.specs : value.split(" ");
}

export function parseImpactMap(text: string): ImpactMap | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { commit, specs, files } = value as Partial<ImpactMap>;
  if (typeof commit !== "string" || !Array.isArray(specs) || specs.length === 0) return undefined;
  if (!specs.every((spec) => typeof spec === "string")) return undefined;
  if (typeof files !== "object" || files === null) return undefined;
  if (!Object.values(files).every((specList) => typeof specList === "string")) return undefined;
  return { commit, specs, files };
}

/** Merge the per-test records in `recordDir` into the committed map. */
export function writeImpactMap(recordDir: string, repoRoot: string, commit: string) {
  const records = readdirSync(recordDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(recordDir, name), "utf8")) as ImpactRecord);
  const map = buildImpactMap(records, commit);
  const text = `${JSON.stringify(map, null, 2)}\n`;
  writeFileSync(path.join(repoRoot, IMPACT_MAP_PATH), text);
  return { specs: map.specs.length, files: Object.keys(map.files).length, bytes: text.length };
}
