import { describe, expect, it } from "vitest";
import { eventForDate, namesTimeOfDay, sentenceAround, splitDetectedDates } from "./detected-dates";

const now = Date.UTC(2026, 6, 29, 10);
const saturday = Date.UTC(2026, 7, 1, 14);

describe("splitDetectedDates", () => {
  it("cuts the text around each date still ahead", () => {
    const text = "On arrive samedi 16h, clés dans la boîte.";
    const date = { start: 10, length: 10, startMs: saturday, durationS: 0 };
    expect(splitDetectedDates(text, [date], now)).toEqual([
      { text: "On arrive " },
      { text: "samedi 16h", date },
      { text: ", clés dans la boîte." },
    ]);
  });

  it("leaves a date already over as plain text", () => {
    const text = "Je l'ai lu hier.";
    const yesterday = { start: 11, length: 4, startMs: now - 86_400_000, durationS: 0 };
    expect(splitDetectedDates(text, [yesterday], now)).toEqual([{ text }]);
  });

  it("keeps a range that started earlier but is still running", () => {
    const text = "Réunion de 9h à 11h";
    const meeting = { start: 11, length: 8, startMs: now - 3_600_000, durationS: 7200 };
    expect(splitDetectedDates(text, [meeting], now).map((s) => s.text)).toEqual([
      "Réunion de ",
      "9h à 11h",
    ]);
  });

  it("drops ranges that overlap or run past the text", () => {
    const text = "dimanche à 9h";
    const whole = { start: 0, length: 13, startMs: saturday, durationS: 0 };
    const inside = { start: 11, length: 2, startMs: saturday, durationS: 0 };
    const outside = { start: 5, length: 40, startMs: saturday, durationS: 0 };
    expect(splitDetectedDates(text, [inside, whole, outside], now)).toEqual([
      { text: "dimanche à 9h", date: whole },
    ]);
  });

  it("returns the text whole when nothing was found", () => {
    expect(splitDetectedDates("", [], now)).toEqual([{ text: "" }]);
    expect(splitDetectedDates("Pas de date ici.", [], now)).toEqual([{ text: "Pas de date ici." }]);
  });
});

describe("namesTimeOfDay", () => {
  it("tells a time from a bare day", () => {
    for (const words of [
      "samedi 16h",
      "à 15 h 30",
      "lundi 9h30",
      "at 3pm",
      "10:45",
      "demain midi",
    ]) {
      expect(namesTimeOfDay(words)).toBe(true);
    }
    for (const words of ["samedi", "3 août", "next Friday", "le 12 septembre 2026"]) {
      expect(namesTimeOfDay(words)).toBe(false);
    }
  });
});

describe("sentenceAround", () => {
  it("takes the sentence that holds the date", () => {
    const text = "C'est prêt. Le marché est dimanche à 9h, à 300 m. Il fera beau.";
    const start = text.indexOf("dimanche");
    expect(sentenceAround(text, start, 13)).toBe("Le marché est dimanche à 9h, à 300 m");
  });

  it("caps a long sentence", () => {
    const text = `Rendez-vous samedi ${"et encore ".repeat(20)}`;
    const title = sentenceAround(text, 12, 6);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("eventForDate", () => {
  it("gives a timed date an hour unless the words carry an end", () => {
    const text = "On arrive samedi 16h.";
    const date = { start: 10, length: 10, startMs: saturday, durationS: 0 };
    expect(eventForDate(date, text)).toEqual({
      title: "On arrive samedi 16h",
      startMs: saturday,
      endMs: saturday + 3_600_000,
      allDay: false,
    });
    expect(eventForDate({ ...date, durationS: 7200 }, text).endMs).toBe(saturday + 7_200_000);
  });

  it("makes a bare day an all-day event", () => {
    const text = "Le marché est samedi.";
    expect(
      eventForDate({ start: 14, length: 6, startMs: saturday, durationS: 0 }, text).allDay,
    ).toBe(true);
  });
});
