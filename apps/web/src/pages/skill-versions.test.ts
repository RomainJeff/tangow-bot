import { ORPCError } from "@orpc/client";
import type { SkillVersion } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { applyUndo, formatVersionDate, refusalMessage } from "./skill-versions";

const bot = { kind: "bot", botId: "bot-1", botName: "Scout" } as const;

function version(id: number, patch: Partial<SkillVersion> = {}): SkillVersion {
  return {
    versionId: `v${String(id).padStart(6, "0")}-0123abcd`,
    createdAt: "2026-10-07T18:40:00.000Z",
    author: bot,
    nature: "modified",
    current: false,
    undone: false,
    ...patch,
  };
}

describe("applyUndo", () => {
  const list = [
    version(3, { current: true }),
    version(2, { undone: true }),
    version(1, { nature: "created" }),
  ];

  it("retires the current version and makes the nearest older live one current", () => {
    const next = applyUndo(list);
    expect(next.map((entry) => [entry.current, entry.undone])).toEqual([
      [false, true],
      [false, true],
      [true, false],
    ]);
  });

  it("leaves the list alone when nothing older is left", () => {
    expect(applyUndo([version(1, { current: true, nature: "created" })])).toEqual([
      version(1, { current: true, nature: "created" }),
    ]);
  });
});

describe("formatVersionDate", () => {
  const now = new Date("2026-10-10T12:00:00");
  const words = { locale: "en", today: "Today", yesterday: "Yesterday" };

  it("reads as the thread's time markers do, Today and Yesterday first", () => {
    expect(formatVersionDate("2026-10-10T08:05:00", words, now)).toBe("Today 8:05 AM");
    expect(formatVersionDate("2026-10-09T18:40:00", words, now)).toBe("Yesterday 6:40 PM");
    expect(formatVersionDate("2026-10-07T18:40:00", words, now)).toBe("Wed, Oct 7 6:40 PM");
  });

  it("is empty for a date it cannot read", () => {
    expect(formatVersionDate("never", words, now)).toBe("");
  });
});

describe("refusalMessage", () => {
  it("returns the server sentence of a refusal and nothing for other failures", () => {
    const refusal = new ORPCError("CONFLICT", {
      message: "This skill changed. Reload and try again.",
    });
    expect(refusalMessage(refusal)).toBe("This skill changed. Reload and try again.");
    expect(refusalMessage(new TypeError("fetch failed"))).toBeNull();
  });

  it("keeps a server fault's wording out of the screen", () => {
    expect(refusalMessage(new ORPCError("INTERNAL_SERVER_ERROR", { message: "boom" }))).toBeNull();
    expect(
      refusalMessage(new ORPCError("SERVICE_UNAVAILABLE", { message: "Skills are unavailable." })),
    ).toBeNull();
  });
});
