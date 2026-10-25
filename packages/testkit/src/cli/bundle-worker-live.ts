/**
 * Bundles the live lanes for a Node 22 host that has no checkout: one ES module beside PGlite's
 * assets and the migrations, the guest bundle the worker template copies, the hand-written guest
 * the refusal lane runs in its place, and the two modules
 * the E2B SDK imports at runtime to upload template files. Two modules the lanes never call are
 * stubs: Koffi, native, loaded for macOS and Windows path checks on a Linux host, and jsdom, which
 * reads its stylesheet from beside its own sources, for web pages.
 *
 *   pnpm test:worker-live:bundle   →  packages/testkit/dist/worker-live/
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleGuest } from "@rakazo/agent-run-worker/bundle";
import { build } from "esbuild";
import { HOSTILE_GUEST_BUILD } from "../worker-live/hostile-guest-build.js";

const require = createRequire(import.meta.url);
const OUT = fileURLToPath(new URL("../../dist/worker-live/", import.meta.url));
const ENTRY = fileURLToPath(new URL("./worker-live.ts", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../../db/prisma/migrations/", import.meta.url));
const PGLITE = path.dirname(
  createRequire(require.resolve("@rakazo/db/pglite.test-support")).resolve("@electric-sql/pglite"),
);
const E2B_DEPENDENCIES = path.join(
  require.resolve("e2b").split("/node_modules/e2b/")[0]!,
  "node_modules",
);
const REQUIRE_BANNER =
  'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);';

const STUBS: Record<string, string> = {
  koffi: 'export default { load() { throw new Error("Koffi is not in the live bundle"); } };',
  jsdom:
    'export class JSDOM { constructor() { throw new Error("jsdom is not in the live bundle"); } }',
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: REQUIRE_BANNER },
  logLevel: "warning",
} as const;

await rm(OUT, { recursive: true, force: true });
await build({
  ...common,
  entryPoints: [ENTRY],
  outfile: path.join(OUT, "bin", "worker-live.mjs"),
  // The lanes load esbuild only to build the hand-written guest from source; the bundle carries it.
  external: [...Object.keys(STUBS), "esbuild"],
});
for (const [name, source] of Object.entries(STUBS)) {
  const dir = path.join(OUT, "bin", "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.mjs"), `${source}\n`);
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, type: "module", exports: "./index.mjs" }),
  );
}
for (const asset of ["pglite.wasm", "initdb.wasm", "pglite.data"]) {
  await cp(path.join(PGLITE, asset), path.join(OUT, "bin", asset));
}
for (const name of ["glob", "tar"]) {
  const dir = path.join(OUT, "bin", "node_modules", name);
  await mkdir(dir, { recursive: true });
  await build({
    ...common,
    stdin: { contents: `export * from "${name}";`, resolveDir: E2B_DEPENDENCIES },
    outfile: path.join(dir, "index.mjs"),
  });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name, type: "module", exports: "./index.mjs" }),
  );
}
await cp(MIGRATIONS, path.join(OUT, "prisma", "migrations"), { recursive: true });
await bundleGuest(path.join(OUT, "guest", "agent-run-worker.mjs"));
execFileSync("tar", [
  "-cf",
  path.join(OUT, "guest", "managed-skills.tar"),
  "-C",
  path.join(OUT, "guest", "managed-skills"),
  "agent",
]);
await build({ ...HOSTILE_GUEST_BUILD, outfile: path.join(OUT, "guest", "hostile-guest.mjs") });
console.log(`Bundled the live lanes in ${path.relative(process.cwd(), OUT)}`);
