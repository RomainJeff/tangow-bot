import type { HarnessChoice } from "@rakazo/contracts";
import { isNativeHarness, NATIVE_HARNESSES } from "@rakazo/contracts";

/** The name a harness goes by on every surface: Rakazo's own carries the product name. */
export function harnessName(choice: HarnessChoice): string {
  return isNativeHarness(choice) ? NATIVE_HARNESSES[choice].name : "Rakazo";
}
