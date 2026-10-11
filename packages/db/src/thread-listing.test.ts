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

  it("previews a message of skill lines by its first line, and a reply by its words", () => {
    const line = (name: string, change: string) => ({
      kind: "skill_source",
      skillUid: "0123456789abcdef0123456789abcdef",
      skillId: `user:${name.toLowerCase()}`,
      name,
      change,
    });
    expect(previewFromBlocks([line("Coffee", "learned"), line("Tea", "deleted")])).toBe(
      "Skill learned · Coffee",
    );
    expect(previewFromBlocks([line("Tea", "updated")])).toBe("Skill updated · Tea");
    expect(previewFromBlocks([{ kind: "text", text: "Saved." }, line("Coffee", "learned")])).toBe(
      "Saved.",
    );
  });

  it("is empty without a text block", () => {
    expect(previewFromBlocks(undefined)).toBe("");
    expect(previewFromBlocks([{ kind: "image", url: "https://example.test/a.png" }])).toBe("");
  });
});
