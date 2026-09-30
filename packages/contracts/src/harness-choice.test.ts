import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  CHATGPT_OAUTH_PROVIDER,
  NATIVE_HARNESSES,
  NativeHarnessChoiceSchema,
} from "./harness-choice.js";

describe("NATIVE_HARNESSES", () => {
  it("names every native harness and pairs it with its own subscription provider", () => {
    expect(Object.keys(NATIVE_HARNESSES).sort()).toEqual(
      [...NativeHarnessChoiceSchema.options].sort(),
    );
    expect(NATIVE_HARNESSES["codex-native"]).toEqual({
      name: "Codex",
      provider: CHATGPT_OAUTH_PROVIDER,
    });
    expect(NATIVE_HARNESSES["claude-native"]).toEqual({
      name: "Claude",
      provider: ANTHROPIC_OAUTH_PROVIDER,
    });
  });
});
