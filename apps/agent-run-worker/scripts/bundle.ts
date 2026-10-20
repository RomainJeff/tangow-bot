import { fileURLToPath } from "node:url";
import { WORKER_NATIVE_TOOLS } from "@rakazo/adapters/runtime-worker";
import { build } from "esbuild";
import { piToolManifest } from "../src/harness/pi-tools.js";

const ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));
export const GUEST_BUNDLE = fileURLToPath(new URL("../dist/agent-run-worker.mjs", import.meta.url));

/** The guest as one ES module that runs with `node` and no node_modules. */
export async function bundleGuest(outfile = GUEST_BUNDLE): Promise<string> {
  if (JSON.stringify(WORKER_NATIVE_TOOLS) !== JSON.stringify(piToolManifest())) {
    throw new Error("Pi tool manifest is stale. Run the worker tools:manifest script.");
  }
  await build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // Bundled CommonJS dependencies call require, which an ES module lacks.
    banner: {
      js: 'import { createRequire as rakazoCreateRequire } from "node:module"; const require = rakazoCreateRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundleGuest();
