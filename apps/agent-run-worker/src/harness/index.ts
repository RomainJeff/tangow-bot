import type { GuestHarness } from "../harness.js";
import { piHarness } from "./pi.js";

/** The harnesses a worker image can run, by the name `RAKAZO_WORKER_HARNESS` selects. */
export const HARNESSES: Readonly<Record<string, GuestHarness>> = { pi: piHarness };
