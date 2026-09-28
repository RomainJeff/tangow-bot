import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClippedPreview } from "./clipped-preview.js";

describe("ClippedPreview", () => {
  it("renders short content as is, with no fade and no badge", () => {
    const html = renderToString(
      <ClippedPreview
        text={"one\ntwo\nthree"}
        maxLines={8}
        fadeFrom="from-background"
        onOpen={() => {}}
        ariaLabel="Report, Accor watch"
      >
        <p>short report</p>
      </ClippedPreview>,
    );

    expect(html).toContain('data-capped="false"');
    expect(html).toContain("short report");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Maximize2".toLowerCase());
  });

  it("cuts content that hides at least three more lines, with a fade and an expand badge", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const html = renderToString(
      <ClippedPreview
        text={longText}
        maxLines={8}
        fadeFrom="from-background"
        onOpen={() => {}}
        ariaLabel="Report, Accor watch · Opens in full"
      >
        <p>long report</p>
      </ClippedPreview>,
    );

    expect(html).toContain('data-capped="true"');
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Report, Accor watch · Opens in full"');
    expect(html).toContain("bg-linear-to-t");
    expect(html).toContain("from-background");
    expect(html).toContain("long report");
  });

  it("stays decorative (no button) when onOpen is omitted, for a card that already opens itself", () => {
    const longText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const html = renderToString(
      <ClippedPreview text={longText} maxLines={5} fadeFrom="from-surface">
        <p>long result</p>
      </ClippedPreview>,
    );

    expect(html).toContain('data-capped="true"');
    expect(html).not.toContain("<button");
    expect(html).toContain("bg-linear-to-t");
    expect(html).toContain("long result");
  });

  it("does not cut when it would only hide the last line or two", () => {
    // maxLines(8) + 3 = 11: ten lines is not enough to cut.
    const almostLongText = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const html = renderToString(
      <ClippedPreview
        text={almostLongText}
        maxLines={8}
        fadeFrom="from-surface"
        onOpen={() => {}}
        ariaLabel="Task"
      >
        <p>ten lines</p>
      </ClippedPreview>,
    );

    expect(html).toContain('data-capped="false"');
    expect(html).not.toContain("<button");
  });
});
