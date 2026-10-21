import { describe, expect, it } from "vitest";
import { prunePiAiImages } from "./pi-ai-images.js";

const image = (data: string) => ({ type: "image", data, mimeType: "image/png" });

function toolTurn(id: string, toolName: string, text: string, data: string) {
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: toolName, arguments: {} }] },
    {
      role: "toolResult",
      toolCallId: id,
      toolName,
      content: [{ type: "text", text }, image(data)],
    },
  ];
}

const imageCount = (messages: readonly { content?: unknown }[]) =>
  messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part.type === "image").length;

describe("prunePiAiImages", () => {
  it("keeps at most K images over 20 captures and rewrites the prefix only once per block", () => {
    const transcript: Array<{ role: string; content?: unknown }> = [
      { role: "user", content: "Fill the form" },
    ];
    const sentImages: number[] = [];
    let rewrites = 0;
    let previous: readonly { role: string; content?: unknown }[] = [];
    for (let capture = 1; capture <= 20; capture += 1) {
      transcript.push(
        ...toolTurn(`call-${capture}`, "computer_screenshot", "Screen", `frame-${capture}`),
      );
      const sent = prunePiAiImages(transcript, 3);
      sentImages.push(imageCount(sent));
      expect(JSON.stringify(sent.at(-1))).toContain(`frame-${capture}`);
      if (JSON.stringify(sent.slice(0, previous.length)) !== JSON.stringify(previous))
        rewrites += 1;
      previous = sent;
    }
    expect(sentImages).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2]);
    expect(rewrites).toBe(6);
  });

  it("counts and prunes a native read of an image file like a screenshot", () => {
    const transcript = [
      { role: "user", content: "Compare the mockup with the page" },
      ...toolTurn("shot-1", "computer_screenshot", "Screen", "frame-1"),
      ...toolTurn("read-1", "read", "Read image file [image/png]", "mockup"),
      ...toolTurn("shot-2", "computer_screenshot", "Screen", "frame-2"),
    ];
    expect(prunePiAiImages(transcript, 2).map((message) => message.content)).toEqual([
      "Compare the mockup with the page",
      transcript[1]?.content,
      [{ type: "text", text: "Screen" }],
      transcript[3]?.content,
      [{ type: "text", text: "Read image file [image/png]" }],
      transcript[5]?.content,
      [{ type: "text", text: "Screen" }, image("frame-2")],
    ]);
  });

  it("leaves room in the model's budget for the images the user attached", () => {
    const transcript = [
      { role: "user", content: [{ type: "text", text: "Match this" }, image("mockup")] },
      ...toolTurn("shot-1", "computer_screenshot", "Screen", "frame-1"),
      ...toolTurn("shot-2", "computer_screenshot", "Screen", "frame-2"),
    ];
    expect(JSON.stringify(prunePiAiImages(transcript, 2)).match(/mockup|frame-\d/g)).toEqual([
      "mockup",
      "frame-2",
    ]);
    expect(() => prunePiAiImages(transcript, 0)).toThrow(
      "The configured model image limit is 0, but the prompt contains 1 attached images.",
    );
  });
});
