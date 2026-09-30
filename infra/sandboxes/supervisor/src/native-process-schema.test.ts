import { describe, expect, it } from "vitest";
import { nativeProcessSchema } from "./native-process-schema.js";

describe("native process request bounds", () => {
  it("accepts at most 24 arguments and two private files within the existing size limits", () => {
    expect(
      nativeProcessSchema.safeParse({
        argv: ["claude", ...Array.from({ length: 23 }, () => "x".repeat(512))],
        cwd: ".",
        files: [
          { path: "mcp-config.json", content: "{}" },
          { path: "system-prompt.md", content: "x".repeat(8_192) },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts a real run's system prompt larger than a config file", () => {
    // Fixed guidance alone is ~5 KB; bot instructions, memory, scratchpad, bot
    // directory and skills routinely push a real run past 8 KB.
    expect(
      nativeProcessSchema.safeParse({
        argv: ["claude"],
        cwd: ".",
        files: [{ path: "system-prompt.md", content: "x".repeat(40 * 1024) }],
      }).success,
    ).toBe(true);
  });

  it.each([
    { label: "25 arguments", argv: Array.from({ length: 25 }, () => "claude") },
    { label: "a 513-character argument", argv: ["claude", "x".repeat(513)] },
    { label: "an empty argument", argv: ["claude", ""] },
    {
      label: "an oversized config file",
      files: [{ path: "mcp-config.json", content: "x".repeat(8_193) }],
    },
    {
      label: "an oversized system prompt",
      files: [{ path: "system-prompt.md", content: "x".repeat(256 * 1024 + 1) }],
    },
    { label: "an unlisted file", files: [{ path: "other.md", content: "" }] },
    { label: "a path traversal", files: [{ path: "../system-prompt.md", content: "" }] },
    {
      label: "three files",
      files: [
        { path: "config.toml", content: "" },
        { path: "mcp-config.json", content: "{}" },
        { path: "system-prompt.md", content: "" },
      ],
    },
  ])("rejects $label", ({ label: _label, ...invalid }) => {
    expect(nativeProcessSchema.safeParse({ argv: ["claude"], cwd: ".", ...invalid }).success).toBe(
      false,
    );
  });
});
