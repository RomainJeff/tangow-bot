import { describe, expect, it } from "vitest";
import { messageTimeLabel } from "./message-time";

/** Local wall-clock instant as ISO, so the expectations hold in any timezone. */
function localIso(hour: number, minute: number): string {
  return new Date(2026, 8, 17, hour, minute).toISOString();
}

describe("messageTimeLabel", () => {
  it("reads hours and minutes in the reader's locale", () => {
    expect(messageTimeLabel(localIso(9, 5), "en-US")).toBe("9:05 AM");
    expect(messageTimeLabel(localIso(21, 40), "en-US")).toBe("9:40 PM");
    expect(messageTimeLabel(localIso(21, 40), "fr-FR")).toBe("21:40");
  });

  it("falls back to English when no locale is active yet", () => {
    expect(messageTimeLabel(localIso(9, 5), "")).toBe("9:05 AM");
  });
});
