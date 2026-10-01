import * as z from "zod";

export const ANTHROPIC_OAUTH_PROVIDER = "anthropic";
export const CHATGPT_OAUTH_PROVIDER = "openai-codex";

export const HarnessChoiceSchema = z.enum(["default", "codex-native", "claude-native"]);
export type HarnessChoice = z.infer<typeof HarnessChoiceSchema>;

export const NativeHarnessChoiceSchema = HarnessChoiceSchema.exclude(["default"]);
export type NativeHarnessChoice = z.infer<typeof NativeHarnessChoiceSchema>;

/** Format version of the choice snapshot a Run records (not the bot's change counter). */
export const RUN_CHOICE_VERSION = 1;

export function isNativeHarness(value: unknown): value is NativeHarnessChoice {
  return NativeHarnessChoiceSchema.safeParse(value).success;
}

export type RunChoice = {
  harness: NativeHarnessChoice;
  executionTarget: string;
  choiceVersion: typeof RUN_CHOICE_VERSION;
};

/**
 * A harness choice as the snapshot a Run records. The only target it can name is the
 * Computer the caller has already authorized for the bot (the one attached to it, or a
 * delegated task's mission Computer); without a native harness or such a Computer there
 * is no choice. The one place a bot's choice becomes a Run choice, for the send boundary
 * and the executor alike.
 */
export function nativeRunChoice(
  saved: unknown,
  authorizedComputerId: string | null | undefined,
): RunChoice | undefined {
  if (!isNativeHarness(saved) || !authorizedComputerId) return undefined;
  return {
    harness: saved,
    executionTarget: authorizedComputerId,
    choiceVersion: RUN_CHOICE_VERSION,
  };
}

/**
 * Who each native harness is: the product name and the subscription provider
 * whose models it can run. The one place this pairing lives; callers render or
 * enforce it, and any translated wording stays with the caller.
 */
export const NATIVE_HARNESSES: Record<NativeHarnessChoice, { name: string; provider: string }> = {
  "codex-native": { name: "Codex", provider: CHATGPT_OAUTH_PROVIDER },
  "claude-native": { name: "Claude", provider: ANTHROPIC_OAUTH_PROVIDER },
};

/** Whether each native harness can be chosen for a bot, as the backend would accept it. */
export const NativeHarnessAvailabilitySchema = z.record(NativeHarnessChoiceSchema, z.boolean());
export type NativeHarnessAvailability = z.infer<typeof NativeHarnessAvailabilitySchema>;
