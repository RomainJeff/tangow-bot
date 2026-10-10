import { describe, expect, it } from "vitest";
import { previewFromBlocks } from "./thread-listing.js";

describe("previewFromBlocks", () => {
  it("previews a message's words without its markdown", () => {
    expect(
      previewFromBlocks([
        { kind: "reasoning", text: "thinking" },
        { kind: "text", text: "## Done\n\n**3** files in [the folder](https://example.test/f)" },
      ]),
    ).toBe("Done 3 files in the folder");
  });

  it("skips a block made only of syntax", () => {
    expect(
      previewFromBlocks([
        { kind: "text", text: "---" },
        { kind: "text", text: "Next **step**" },
      ]),
    ).toBe("Next step");
  });

  it("is empty without a text block", () => {
    expect(previewFromBlocks(undefined)).toBe("");
    expect(previewFromBlocks([{ kind: "image", url: "https://example.test/a.png" }])).toBe("");
  });
});
