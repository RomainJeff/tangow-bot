import type { GuestHarness } from "../harness.js";
import { piNativeHarness } from "./pi-native.js";

/** The harnesses a worker image can run, by the name `TANGOW_WORKER_HARNESS` selects. */
export const HARNESSES: Readonly<Record<string, GuestHarness>> = {
  "pi-native": piNativeHarness,
};
