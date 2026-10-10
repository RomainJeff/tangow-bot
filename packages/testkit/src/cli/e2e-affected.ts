import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildImporters,
  type Selection,
  selectSpecs,
  type WorkspacePackage,
} from "../e2e-affected.js";
import { IMPACT_MAP_PATH, type ImpactMap, parseImpactMap } from "../e2e-impact.js";
import { runProcess } from "./process.js";

const args = process.argv.slice(2);
const baseArg = args.find((arg) => arg.startsWith("--base="));
const base = baseArg?.slice("--base=".length) ?? "origin/main";
const dryRun = args.includes("--dry-run");
const harnessArgs = args.filter((arg) => arg !== baseArg && arg !== "--dry-run");
if (harnessArgs.some((arg) => arg.startsWith("--spec=") || arg.startsWith("--grep="))) {
  throw new Error(
    "test:e2e:affected picks the specs itself; use pnpm test:e2e for --spec or --grep",
  );
}

const git = (...gitArgs: string[]) =>
  execFileSync("git", gitArgs, { encoding: "utf8" }).split("\n").filter(Boolean);
const repoRoot = git("rev-parse", "--show-toplevel")[0]!;
process.chdir(repoRoot);

const changed = [
  ...new Set([
    ...git("diff", "--name-only", "--no-renames", "--merge-base", base),
    ...git("ls-files", "--others", "--exclude-standard"),
  ]),
];
const repoFiles = new Set(
  git("ls-files", "--cached", "--others", "--exclude-standard").filter((file) => existsSync(file)),
);
const specsOnDisk = readdirSync("apps/web/e2e").filter((name) => name.endsWith(".spec.ts"));
const map = existsSync(IMPACT_MAP_PATH)
  ? parseImpactMap(readFileSync(IMPACT_MAP_PATH, "utf8"))
  : undefined;
const importers = buildImporters(
  repoFiles,
  (file) => readFileSync(file, "utf8"),
  workspacePackages(),
);
const selection = selectSpecs({ changed, map, specsOnDisk, importers });

console.log(describe(selection, map));
if (selection.kind === "none" || dryRun) process.exit(0);
const specArgs =
  selection.kind === "specs"
    ? [`--spec=${selection.specs.map((spec) => `e2e/${spec}`).join(",")}`]
    : [];
runProcess("pnpm", ["test:e2e", ...specArgs, ...harnessArgs], process.env).then(
  () => process.exit(0),
  () => process.exit(1),
);

function workspacePackages() {
  const packages = new Map<string, WorkspacePackage>();
  for (const name of readdirSync("packages")) {
    const manifest = path.posix.join("packages", name, "package.json");
    if (!existsSync(manifest)) continue;
    const { name: packageName, exports } = JSON.parse(readFileSync(manifest, "utf8"));
    packages.set(packageName, { dir: path.posix.join("packages", name), exports });
  }
  return packages;
}

function describe(selection: Selection, impactMap: ImpactMap | undefined) {
  const lines: string[] = [];
  if (impactMap)
    lines.push(
      `Impact map: ${mapAge(impactMap.commit)}. Changes since ${base}: ${changed.length} files.`,
    );
  if (selection.kind === "full") {
    lines.push(`Full e2e suite: ${selection.reason}.`);
    if (selection.uncovered.length) {
      lines.push(
        `No spec runs: ${selection.uncovered.join(", ")}`,
        "Decide whether one of these deserves an e2e: add one only for a user-visible flow no unit test can prove, then run the test-audit skill.",
      );
    }
    return lines.join("\n");
  }
  if (selection.kind === "specs") {
    lines.push(`Running ${selection.specs.length} of ${specsOnDisk.length} specs.`);
    const specsByReason = new Map<string, string[]>();
    for (const spec of selection.specs) {
      for (const reason of selection.because[spec]!) {
        specsByReason.set(reason, [...(specsByReason.get(reason) ?? []), spec]);
      }
    }
    for (const [reason, specs] of specsByReason) {
      lines.push(`  ${reason} -> ${specs.length > 5 ? `${specs.length} specs` : specs.join(", ")}`);
    }
  } else {
    lines.push("No e2e spec is affected.");
  }
  if (selection.ignored.length) lines.push(`Ignored: ${selection.ignored.join(", ")}`);
  const unmapped = specsOnDisk.filter((spec) => !impactMap?.specs.includes(spec));
  if (unmapped.length)
    lines.push(
      `The impact map is stale: ${unmapped.length} specs are missing from it and always run. Rerecord it with pnpm test:e2e:impact-map.`,
    );
  return lines.join("\n");
}

function mapAge(commit: string) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "ignore" });
  } catch {
    return `stale, recorded at ${commit.slice(0, 9)} outside this branch's history; rerecord it with pnpm test:e2e:impact-map`;
  }
  const behind = git("rev-list", "--count", `${commit}..HEAD`)[0];
  return `recorded at ${commit.slice(0, 9)}, ${behind} commits ago`;
}
