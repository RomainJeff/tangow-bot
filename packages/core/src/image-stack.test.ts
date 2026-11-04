import type { EntryId } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { stackCards } from "./image-stack.js";
import type { StackImage } from "./session-log/project-thread-view.js";

const image = (n: number): StackImage => ({
  messageId: `msg_${n}` as EntryId,
  artifactId: `art_${n}`,
  mimeType: "image/png",
  name: `${n}.png`,
  ts: "2026-11-01T10:00:00.000Z",
});
const images = (count: number) => Array.from({ length: count }, (_, n) => image(n));

describe("stackCards", () => {
  it("keeps the front and the cards behind it, deepest first, from a long stack", () => {
    expect(stackCards(images(15)).map((card) => [card.image.artifactId, card.depth])).toEqual([
      ["art_11", 3],
      ["art_12", 2],
      ["art_13", 1],
      ["art_14", 0],
    ]);
  });

  it("holds a single image as the front alone, and keeps a card's key as it moves back", () => {
    expect(stackCards(images(1)).map((card) => card.depth)).toEqual([0]);
    const before = stackCards(images(3)).find((card) => card.image.artifactId === "art_2");
    const after = stackCards(images(4)).find((card) => card.image.artifactId === "art_2");
    expect([before?.depth, after?.depth]).toEqual([0, 1]);
    expect(after?.key).toBe(before?.key);
  });
});
