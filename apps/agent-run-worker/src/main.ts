import { Console } from "node:console";
import path from "node:path";
import { streamChannel, WORKER_LIMITS } from "@rakazo/adapters/runtime-worker/wire";
import { runGuest } from "./guest.js";
import { HARNESSES } from "./harness/index.js";

// stdout carries frames: everything that logs goes to stderr instead.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const capability = process.env.RAKAZO_WORKER_CAPABILITY;
const harness = HARNESSES[process.env.RAKAZO_WORKER_HARNESS ?? "pi-native"];
if (!capability || !harness) {
  console.error("RAKAZO_WORKER_CAPABILITY or RAKAZO_WORKER_HARNESS is missing or unknown");
  process.exit(2);
}
const home = process.env.RAKAZO_WORKER_HOME;
if (!home || !path.isAbsolute(home)) {
  console.error("RAKAZO_WORKER_HOME must be an explicit absolute path");
  process.exit(2);
}
// Commands the run starts do not inherit it. They can still read it from this process's
// /proc environ: the guest is hostile and holds it anyway, so this is hygiene, not a boundary.
delete process.env.RAKAZO_WORKER_CAPABILITY;

// Termination stops the run's tools first: each command runs in a process group of its own.
const terminated = new AbortController();
process.once("SIGTERM", () => terminated.abort());

async function* stdio() {
  yield streamChannel(process.stdin, process.stdout, WORKER_LIMITS.controllerFrameBytes);
}

const exit = await runGuest({
  channels: stdio(),
  capability,
  harness,
  root: process.env.RAKAZO_WORKER_ROOT,
  home,
  signal: terminated.signal,
});
console.error(`agent run worker: ${exit}`);
process.exit(exit === "done" || exit === "paused" ? 0 : 1);
