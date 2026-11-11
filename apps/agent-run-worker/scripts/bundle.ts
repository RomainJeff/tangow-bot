import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_NATIVE_TOOLS } from "@tangow/adapters/runtime-worker";
import { build } from "esbuild";
import { piToolManifest } from "../src/harness/pi-tools.js";

const ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));
export const GUEST_BUNDLE = fileURLToPath(new URL("../dist/agent-run-worker.mjs", import.meta.url));

/** The guest holds no credential, so nothing that connects an MCP server, brokers OAuth or opens the database may reach its bundle. */
const HOST_ONLY_INPUTS = [
  /node_modules\/@modelcontextprotocol\/sdk\//,
  /packages\/adapters\/src\/(mcp-|remote-mcp|connector-safety|secrets)/,
  /packages\/db\//,
  /node_modules\/@prisma\//,
];

/** The guest as one ES module that runs with `node` and no node_modules. */
export async function bundleGuest(outfile = GUEST_BUNDLE): Promise<string> {
  if (JSON.stringify(WORKER_NATIVE_TOOLS) !== JSON.stringify(piToolManifest())) {
    throw new Error("Pi tool manifest is stale. Run the worker tools:manifest script.");
  }
  const managed = path.join(path.dirname(outfile), "managed-skills", "agent");
  await rm(managed, { recursive: true, force: true });
  await mkdir(path.dirname(managed), { recursive: true });
  await cp(fileURLToPath(new URL("../../../skills/agent", import.meta.url)), managed, {
    recursive: true,
  });
  const { metafile } = await build({
    metafile: true,
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
  const leaked = Object.keys(metafile.inputs).filter((input) =>
    HOST_ONLY_INPUTS.some((pattern) => pattern.test(input)),
  );
  if (leaked.length > 0) {
    throw new Error(`The guest bundle contains host-only modules: ${leaked.join(", ")}`);
  }
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await bundleGuest();
