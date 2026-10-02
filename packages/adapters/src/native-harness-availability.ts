import type { HarnessChoice, NativeHarnessChoice } from "@rakazo/contracts";
import { NATIVE_HARNESSES, NativeHarnessChoiceSchema } from "@rakazo/contracts";

/**
 * Why a native harness cannot serve a bot, or null when it can: it needs a Computer to run in
 * and a model on the subscription it speaks to. The one verdict behind the save-time refusal,
 * the availability a settings panel shows and a delegated specialist's harness choice; callers
 * word the refusal themselves. The Docker placement is only known once the Computer is
 * provisioned, so the runtime enforces that one at run time.
 */
export function nativeHarnessRefusal(
  harness: NativeHarnessChoice,
  computer: unknown,
  effectiveProvider: string | null | undefined,
): "computer" | "model" | null {
  if (!computer) return "computer";
  if (effectiveProvider !== NATIVE_HARNESSES[harness].provider) return "model";
  return null;
}

/** Every harness a bot can run on: Rakazo's own is always there, a native one when nothing refuses it. */
export function availableHarnesses(
  computer: unknown,
  effectiveProvider: string | null | undefined,
): HarnessChoice[] {
  return [
    "default",
    ...NativeHarnessChoiceSchema.options.filter(
      (harness) => !nativeHarnessRefusal(harness, computer, effectiveProvider),
    ),
  ];
}
