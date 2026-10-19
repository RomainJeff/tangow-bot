import { Console } from "node:console";
import { tmpdir } from "node:os";
import path from "node:path";
import { streamChannel, WORKER_LIMITS } from "@rakazo/adapters/runtime-worker/wire";
import { runGuest } from "./guest.js";
import { HARNESSES } from "./harness/index.js";

// stdout carries frames: everything that logs goes to stderr instead.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const capability = process.env.RAKAZO_WORKER_CAPABILITY;
const harness = HARNESSES[process.env.RAKAZO_WORKER_HARNESS ?? "pi"];
if (!capability || !harness) {
  console.error("RAKAZO_WORKER_CAPABILITY or RAKAZO_WORKER_HARNESS is missing or unknown");
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
  harness,
  spoolDir: process.env.RAKAZO_WORKER_SPOOL_DIR ?? path.join(tmpdir(), "rakazo-tool-output"),
  root: process.env.RAKAZO_WORKER_ROOT,
});
console.error(`agent run worker: ${exit}`);
process.exit(exit === "done" || exit === "paused" ? 0 : 1);
