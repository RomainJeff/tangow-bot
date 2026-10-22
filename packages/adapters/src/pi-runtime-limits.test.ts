import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  billedPromptTokens,
  clipToolResultContent,
  clipToolResultText,
  providerCacheTokens,
  resolveCompletionMaxTokens,
  TOOL_RESULT_TEXT_LIMIT,
} from "./pi-runtime-limits.js";

describe("billedPromptTokens", () => {
  it("adds cache read and write onto uncached input so the meter matches provider cost", () => {
    expect(
      billedPromptTokens({
        input: 12,
        output: 40,
        cacheRead: 8_000,
        cacheWrite: 200,
      }),
    ).toEqual({ inputTokens: 8_212, outputTokens: 40 });
  });

  it("keeps uncached-only usage unchanged when cache fields are absent", () => {
    expect(billedPromptTokens({ input: 100, output: 20 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it("treats a fully cached prompt as billed input rather than zero", () => {
    expect(
      billedPromptTokens({
        input: 0,
        output: 15,
        cacheRead: 12_500,
        cacheWrite: 0,
      }),
    ).toEqual({ inputTokens: 12_500, outputTokens: 15 });
  });
});

describe("providerCacheTokens", () => {
  it("passes the provider counters through untouched", () => {
    expect(providerCacheTokens({ cacheRead: 8_000, cacheWrite: 200 })).toEqual({
      cacheReadTokens: 8_000,
      cacheWriteTokens: 200,
    });
  });

  it("keeps a reported zero, which means the cache was cold", () => {
    expect(providerCacheTokens({ cacheRead: 0, cacheWrite: 0 })).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("omits counters a provider does not report rather than inventing zeros", () => {
    expect(providerCacheTokens({})).toEqual({});
    expect(providerCacheTokens({ cacheRead: 12 })).toEqual({ cacheReadTokens: 12 });
    expect(providerCacheTokens({ cacheRead: Number.NaN })).toEqual({});
  });
});

describe("resolveCompletionMaxTokens", () => {
  it("uses the shared default instead of a model-card ceiling", () => {
    expect(resolveCompletionMaxTokens(128_000)).toBe(DEFAULT_MODEL_MAX_TOKENS);
  });

  it("honors a configured escape hatch up to the model cap", () => {
    expect(resolveCompletionMaxTokens(128_000, 8_192)).toBe(8_192);
    expect(resolveCompletionMaxTokens(2_048, 8_192)).toBe(2_048);
  });

  it("clamps an agent-supplied options maxTokens to the user cap", () => {
    expect(resolveCompletionMaxTokens(128_000, undefined, 128_000)).toBe(DEFAULT_MODEL_MAX_TOKENS);
    expect(resolveCompletionMaxTokens(128_000, 16_384, 128_000)).toBe(16_384);
  });
});

describe("clipToolResultText", () => {
  it("bounds oversized tool output, notice included, and says how much it cut", () => {
    const text = "x".repeat(TOOL_RESULT_TEXT_LIMIT + 50);
    const clipped = clipToolResultText(text);
    expect(clipped).toBe(`${"x".repeat(11_972)}\n[78 more characters cut]`);
    expect(clipToolResultText(clipped)).toBe(clipped);
  });
});

describe("clipToolResultContent", () => {
  it("shares one character budget across all text parts and leaves images", () => {
    const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" as const };
    const clipped = clipToolResultContent([
      { type: "text" as const, text: "a".repeat(11_900) },
      image,
      { type: "text" as const, text: "b".repeat(100) },
      { type: "text" as const, text: "later omitted" },
    ]);
    expect(clipped).toEqual([
      { type: "text", text: "a".repeat(11_900) },
      image,
      { type: "text", text: `${"b".repeat(72)}\n[41 more characters cut]` },
    ]);
    expect(clipToolResultContent(clipped)).toEqual(clipped);
  });

  it("marks text dropped right after a part that used the whole budget", () => {
    expect(
      clipToolResultContent([
        { type: "text" as const, text: "a".repeat(TOOL_RESULT_TEXT_LIMIT) },
        { type: "text" as const, text: "dropped" },
      ]),
    ).toEqual([{ type: "text", text: `${"a".repeat(11_972)}\n[35 more characters cut]` }]);
  });

  it("backs up rather than split an emoji at the cut", () => {
    const text = `${"a".repeat(11_971)}😀${"z".repeat(100)}`;
    expect(clipToolResultContent([{ type: "text" as const, text }])).toEqual([
      { type: "text", text: `${"a".repeat(11_971)}\n[102 more characters cut]` },
    ]);
    expect(clipToolResultText(text)).toBe(`${"a".repeat(11_971)}\n[102 more characters cut]`);
  });
});
