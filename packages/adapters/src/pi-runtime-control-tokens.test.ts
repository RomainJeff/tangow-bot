import { describe, expect, it } from "vitest";
import { stripModelControlTokens } from "./pi-runtime.js";

describe("stripModelControlTokens", () => {
  it("removes a whole-message end token (the reported <|eos|> leak)", () => {
    expect(stripModelControlTokens("<|eos|>")).toBe("");
  });

  it("strips common special/role tokens across models", () => {
    for (const token of [
      "<|eos|>",
      "<|eot_id|>",
      "<|endoftext|>",
      "<|im_end|>",
      "<|im_start|>",
      "<|end_of_turn|>",
      "<|assistant|>",
      "<|user|>",
    ]) {
      expect(stripModelControlTokens(`hello${token}`)).toBe("hello");
    }
  });

  it("strips a token that appears inline, keeping the surrounding text", () => {
    expect(stripModelControlTokens("Voilà le point.<|eos|>")).toBe("Voilà le point.");
    expect(stripModelControlTokens("a<|im_end|>b")).toBe("ab");
  });

  it("leaves ordinary prose untouched, including harmless pipes and angle brackets", () => {
    for (const text of [
      "Nothing to strip here.",
      "a | b > c and 1 < 2",
      "Use the <div> tag, or a|b in a table.",
      "",
    ]) {
      expect(stripModelControlTokens(text)).toBe(text);
    }
  });

  it("does not match a bracketed phrase with spaces (only tight control-token shapes)", () => {
    expect(stripModelControlTokens("<| not a token |>")).toBe("<| not a token |>");
  });
});
