import { describe, expect, it } from "vitest";
import { harnessOptions, showsHarnessHint } from "./harness";

describe("mobile harness choice", () => {
  it("keeps Rakazo available and disables a native harness the server did not offer", () => {
    expect(harnessOptions({ "codex-native": true, "claude-native": false })).toEqual([
      { choice: "default", name: "Rakazo", available: true },
      { choice: "codex-native", name: "Codex", available: true },
      { choice: "claude-native", name: "Claude", available: false },
    ]);
  });

  it("disables both native harnesses until the server answered", () => {
    expect(harnessOptions(null).map((option) => option.available)).toEqual([true, false, false]);
  });

  it("hints only once an unavailable native harness is known", () => {
    expect(showsHarnessHint(null)).toBe(false);
    expect(showsHarnessHint({ "codex-native": true, "claude-native": true })).toBe(false);
    expect(showsHarnessHint({ "codex-native": true, "claude-native": false })).toBe(true);
    expect(showsHarnessHint({ "codex-native": false, "claude-native": false })).toBe(true);
  });
});
