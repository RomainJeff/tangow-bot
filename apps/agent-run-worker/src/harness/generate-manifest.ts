import { writeFile } from "node:fs/promises";
import { piToolManifest } from "./pi-tools.js";

await writeFile(
  new URL("../../../../packages/adapters/src/runtime-worker/pi-tools.json", import.meta.url),
  `${JSON.stringify(piToolManifest(), null, 2)}\n`,
);
