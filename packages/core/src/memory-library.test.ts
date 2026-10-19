import { describe, expect, it } from "vitest";
import { latestAnnotationPerBot, memoryCaptureInput, memoryLocation } from "./memory-library.js";

describe("memory library helpers", () => {
  it("keys a capture by bot and message", () => {
    expect(memoryCaptureInput("m1", "b1")).toEqual({
      messageId: "m1",
      botId: "b1",
      idempotencyKey: "capture:b1:m1",
    });
    expect(memoryCaptureInput("m1")).toEqual({
      messageId: "m1",
      idempotencyKey: "capture:space:m1",
    });
  });

  it("keeps the first annotation per bot", () => {
    const items = [
      { id: "a", bot: { id: "b1" } },
      { id: "b", bot: { id: "b2" } },
      { id: "c", bot: { id: "b1" } },
    ];
    expect(latestAnnotationPerBot(items).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("joins the present location parts", () => {
    expect(memoryLocation("Home", "Agent", undefined)).toBe("Home · Agent");
  });
});
