import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerLinkPreview } from "./composer-link-preview.js";

describe("ComposerLinkPreview", () => {
  it("shows the thumbnail, title and site once ready, as a card that is not a link", () => {
    const html = renderToString(
      <ComposerLinkPreview
        site="example.com"
        title="An article"
        image={<img src="data:image/webp;base64,AAAA" alt="" />}
        removeLabel="Remove preview"
      />,
    );

    expect(html).toContain('data-state="ready"');
    expect(html).toContain("An article");
    expect(html).toContain("example.com");
    expect(html).toContain('src="data:image/webp;base64,AAAA"');
    expect(html).not.toContain("<a ");
    expect(html).toContain("bg-background");
    expect(html).toContain('aria-label="Remove preview"');
    expect(html).toContain("size-composer-remove");
    expect(html).toContain("bg-primary");
    expect(html).toContain("border-surface");
  });

  it("has no image slot without a picture and keeps the title at the padding", () => {
    const html = renderToString(
      <ComposerLinkPreview site="example.com" title="Plain" removeLabel="Remove preview" />,
    );

    expect(html).not.toContain("size-link-thumb");
    expect(html).not.toContain("<img");
  });
});
