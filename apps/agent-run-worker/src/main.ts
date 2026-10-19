import { Console } from "node:console";
import { tmpdir } from "node:os";
import path from "node:path";
import { streamChannel, WORKER_LIMITS } from "@rakazo/adapters/runtime-worker";
import { runGuest } from "./guest.js";

// stdout carries frames: everything that logs goes to stderr instead.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const capability = process.env.RAKAZO_WORKER_CAPABILITY;
if (!capability) {
  console.error("RAKAZO_WORKER_CAPABILITY is not set");
  process.exit(2);
}
// Commands the run starts do not inherit it.
delete process.env.RAKAZO_WORKER_CAPABILITY;

async function* stdio() {
  yield streamChannel(process.stdin, process.stdout, WORKER_LIMITS.controllerFrameBytes);
}

const exit = await runGuest({
  channels: stdio(),
  capability,
  spoolDir: process.env.RAKAZO_WORKER_SPOOL_DIR ?? path.join(tmpdir(), "rakazo-tool-output"),
});
console.error(`agent run worker: ${exit}`);
process.exit(exit === "done" || exit === "paused" ? 0 : 1);
