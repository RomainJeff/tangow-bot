import * as z from "zod";

export const ANTHROPIC_OAUTH_PROVIDER = "anthropic";
export const CHATGPT_OAUTH_PROVIDER = "openai-codex";

export const HarnessChoiceSchema = z.enum(["default", "codex-native", "claude-native"]);
export type HarnessChoice = z.infer<typeof HarnessChoiceSchema>;

export const NativeHarnessChoiceSchema = HarnessChoiceSchema.exclude(["default"]);
export type NativeHarnessChoice = z.infer<typeof NativeHarnessChoiceSchema>;

export function isNativeHarness(value: unknown): value is NativeHarnessChoice {
  return NativeHarnessChoiceSchema.safeParse(value).success;
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
