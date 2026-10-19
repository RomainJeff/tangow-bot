import { describe, expect, it } from "vitest";
import { memoryCaptureInput, memoryLocation } from "./memory-library.js";

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

  it("joins the present location parts", () => {
    expect(memoryLocation("Home", "Agent", undefined)).toBe("Home · Agent");
  });
});
