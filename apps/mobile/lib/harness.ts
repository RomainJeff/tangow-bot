import type { HarnessChoice, NativeHarnessAvailability } from "@rakazo/contracts";
import { isNativeHarness, NATIVE_HARNESSES } from "@rakazo/contracts";
import { harnessName } from "@rakazo/core";

export type HarnessOption = { choice: HarnessChoice; name: string; available: boolean };

const NATIVE_CHOICES = Object.keys(NATIVE_HARNESSES).filter(isNativeHarness);
const CHOICES: HarnessChoice[] = ["default", ...NATIVE_CHOICES];

/**
 * The harnesses a bot can be set to, in the order they are listed. Rakazo's own is always
 * available; a native one is only when the server said so, and none is while that is unknown.
 */
export function harnessOptions(availability: NativeHarnessAvailability | null): HarnessOption[] {
  return CHOICES.map((choice) => ({
    choice,
    name: harnessName(choice),
    available: choice === "default" || availability?.[choice] === true,
  }));
}

/** The one hint shows once the server answered and at least one native harness is unavailable. */
export function showsHarnessHint(availability: NativeHarnessAvailability | null): boolean {
  return availability !== null && NATIVE_CHOICES.some((choice) => !availability[choice]);
}
