import { fileURLToPath } from "node:url";
import type { BuildOptions } from "esbuild";

/** How the hand-written guest of lane e-refusals is bundled: one ES module for the worker VM. */
export const HOSTILE_GUEST_BUILD: BuildOptions = {
  entryPoints: [fileURLToPath(new URL("./hostile-guest.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "warning",
};
