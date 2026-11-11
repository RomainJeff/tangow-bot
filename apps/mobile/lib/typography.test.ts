import { typography } from "@tangow/ui-tokens";
import { describe, expect, it } from "vitest";
import { nativeTextStyle } from "./typography";

describe("nativeTextStyle", () => {
  it("carries a token's size, rounded line height, and letter spacing", () => {
    const style = nativeTextStyle("rowName");
    expect(style.fontSize).toBe(typography.rowName.size);
    expect(style.lineHeight).toBe(Math.round(typography.rowName.size * typography.rowName.leading));
    expect(style.letterSpacing).toBeCloseTo(
      trackingFor(typography.rowName.size, typography.rowName.tracking),
      2,
    );
    expect(style.fontWeight).toBe("400");
  });

  it("reads a zero tracking token as zero letter spacing", () => {
    expect(nativeTextStyle("time").letterSpacing).toBe(0);
  });

  it("casts the token weight to a string RN accepts", () => {
    expect(nativeTextStyle("author").fontWeight).toBe("500");
  });

  it("lets a mobile-only override replace size, leading, and weight", () => {
    // Design contract §1.2: message body is 16/1.5 on mobile vs the shared 16.5/1.58.
    const body = nativeTextStyle("body", { size: 16, leading: 1.5 });
    expect(body.fontSize).toBe(16);
    expect(body.lineHeight).toBe(24);
    // Tracking itself is not overridden, so it still scales off the token's own value.
    expect(body.letterSpacing).toBeCloseTo(trackingFor(16, typography.body.tracking), 3);

    // Design contract §3.7: the thread title is 17/600 on mobile vs the shared 19/1.2/500.
    const title = nativeTextStyle("title", { size: 17, weight: 600 });
    expect(title.fontSize).toBe(17);
    expect(title.fontWeight).toBe("600");
    expect(title.lineHeight).toBe(Math.round(17 * typography.title.leading));
  });
});

function trackingFor(size: number, tracking: string): number {
  return Number.parseFloat(tracking) * size;
}
