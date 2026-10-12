import { SessionEntrySchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { entryPreview, previewFromBlocks } from "./thread-listing.js";

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

describe("entryPreview", () => {
  it("previews a learnt skill by what changed and its name", () => {
    const learnt = SessionEntrySchema.parse({
      id: "entry-1",
      sessionId: "session-1",
      seq: 0,
      parentId: null,
      type: "skill.learnt",
      payload: {
        skillId: "user:coffee",
        name: "Coffee",
        change: "learned",
      },
      botId: "bot-1",
      ts: "2026-10-12T09:00:00.000Z",
    });
    expect(entryPreview(learnt)).toBe("Skill learned · Coffee");
  });
});
