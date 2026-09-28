import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerAttachment } from "./composer-attachment.js";

describe("ComposerAttachment", () => {
  it("renders an image thumbnail when a previewUrl is given", () => {
    const html = renderToString(
      <ComposerAttachment
        name="photo.jpg"
        previewUrl="blob:photo"
        removeLabel="Remove photo.jpg"
      />,
    );

    expect(html).toContain('data-slot="composer-attachment"');
    expect(html).toContain('src="blob:photo"');
    expect(html).toContain('alt="photo.jpg"');
    expect(html).toContain("size-composer-attachment-thumb");
    // Only the × icon — no paperclip.
    expect(html.match(/<svg/g)).toHaveLength(1);
  });

  it("renders a file tile with a paperclip icon and a truncated name when there is no previewUrl", () => {
    const html = renderToString(
      <ComposerAttachment name="statement-2026.pdf" removeLabel="Remove statement-2026.pdf" />,
    );

    expect(html).not.toContain("<img");
    // The paperclip icon and the × icon.
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).toContain("statement-2026.pdf");
    expect(html).toContain("truncate");
    expect(html).toContain("max-w-composer-attachment-tile");
  });

  it("gives the × button the caller's remove label", () => {
    const html = renderToString(
      <ComposerAttachment name="a.png" previewUrl="blob:a" removeLabel="Remove a.png" />,
    );

    expect(html).toContain('aria-label="Remove a.png"');
    expect(html).toContain("size-composer-remove");
  });

  it("spreads the remaining props onto its root", () => {
    const html = renderToString(
      <ComposerAttachment name="a.png" removeLabel="Remove a.png" data-testid="pending-a" />,
    );

    expect(html).toContain('data-testid="pending-a"');
  });
});
