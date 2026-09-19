import { describe, expect, it } from "vitest";
import { formatElapsed, formatShortDuration } from "./format-elapsed";

describe("formatElapsed", () => {
  it("formats under a minute as seconds with one decimal", () => {
    expect(formatElapsed(0, 0)).toBe("0.0s");
    expect(formatElapsed(0, 4_300)).toBe("4.3s");
  });

  it("formats a minute or more as minutes and seconds", () => {
    expect(formatElapsed(0, 62_000)).toBe("1m 2.0s");
    expect(formatElapsed(0, 124_300)).toBe("2m 4.3s");
  });

  it("never goes negative when the clock started after now", () => {
    expect(formatElapsed(10_000, 0)).toBe("0.0s");
  });
});

describe("formatShortDuration", () => {
  it("formats under a minute as whole seconds", () => {
    expect(formatShortDuration(0)).toBe("0s");
    expect(formatShortDuration(41_000)).toBe("41s");
    expect(formatShortDuration(41_400)).toBe("41s");
    expect(formatShortDuration(59_499)).toBe("59s");
  });

  it("pads the seconds of a minute or more", () => {
    expect(formatShortDuration(60_000)).toBe("1m 00s");
    expect(formatShortDuration(124_000)).toBe("2m 04s");
    expect(formatShortDuration(3_600_000)).toBe("60m 00s");
  });

  it("rounds up into the next minute", () => {
    expect(formatShortDuration(59_500)).toBe("1m 00s");
  });

  it("never goes negative", () => {
    expect(formatShortDuration(-5_000)).toBe("0s");
  });
});
