import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LinkPreviewCard, LinkPreviewPicture } from "./link-preview-card.js";

const PICTURE = <div data-testid="picture" />;

describe("LinkPreviewCard", () => {
  it("is one link named after its title and site, on a hairline surface without a shadow", () => {
    const html = renderToString(
      <LinkPreviewCard
        format="compact"
        href="https://example.com/a"
        site="example.com"
        title="A page"
      />,
    );

    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('aria-label="A page, example.com"');
    expect(html).toContain("w-link-card");
    expect(html).toContain("max-w-full");
    expect(html).toContain("animate-arrive");
    expect(html).toContain("bg-surface");
    expect(html).toContain("border-border");
    expect(html).toContain("group-hover/link-card:border-outline");
    expect(html).not.toContain("shadow-");
    expect(html).not.toContain("<button");
  });

  it("compact: a 56 px thumbnail when there is a picture, none otherwise, title on two lines", () => {
    const withPicture = renderToString(
      <LinkPreviewCard
        format="compact"
        href="https://example.com/a"
        site="example.com"
        title="A page"
        image={PICTURE}
      />,
    );
    const without = renderToString(
      <LinkPreviewCard
        format="compact"
        href="https://example.com/a"
        site="example.com"
        title="A page"
      />,
    );

    expect(withPicture).toContain("size-link-thumb");
    expect(withPicture).toContain("rounded-chip");
    expect(withPicture).toContain("bg-secondary");
    expect(withPicture).toContain("line-clamp-2");
    expect(withPicture).toContain('dir="auto"');
    expect(withPicture).toContain("<bdi>A page</bdi>");
    expect(without).not.toContain("size-link-thumb");
  });

  it("large: the picture on top at 1.91:1, then title and site", () => {
    const html = renderToString(
      <LinkPreviewCard
        format="large"
        href="https://example.com/a"
        site="example.com"
        title="A page"
        image={PICTURE}
      />,
    );

    expect(html).toContain("aspect-ratio:1.91");
    expect(html.indexOf('data-testid="picture"')).toBeLessThan(html.indexOf("<bdi>A page"));
    expect(html).toContain("text-muted-foreground");
  });

  it("photo: the picture alone, named after its site, with the site under it", () => {
    const html = renderToString(
      <LinkPreviewCard
        format="photo"
        href="https://images.example.com/p.jpg"
        site="images.example.com"
        image={PICTURE}
        imageRatio={2}
      />,
    );

    expect(html).toContain('aria-label="images.example.com"');
    expect(html).toContain("rounded-bubble");
    expect(html).toContain("max-h-link-photo-max");
    expect(html).toContain("aspect-ratio:2");
    expect(html).not.toContain("bg-surface");
    expect(html).not.toContain("line-clamp-2");
    expect(html.indexOf('data-testid="picture"')).toBeLessThan(
      html.indexOf('<bdi dir="ltr">images'),
    );
  });

  it("wraps a long host instead of truncating its end", () => {
    const html = renderToString(
      <LinkPreviewCard
        format="compact"
        href="https://accounts.google.com.evil.example/"
        site="accounts.google.com.evil.example"
        title="Rakazo : approuver"
      />,
    );

    expect(html).toContain("wrap-anywhere");
    expect(html).not.toContain("truncate");
    expect(html).toContain('aria-label="Rakazo : approuver, accounts.google.com.evil.example"');
  });

  it("renders the title as text, never as markup", () => {
    const html = renderToString(
      <LinkPreviewCard
        format="compact"
        href="https://example.com/"
        site="example.com"
        title={"<img src=x onerror=alert(1)>"}
      />,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it.each([
    "javascript:alert(1)",
    "mailto:a@example.com",
    "tel:+33123456789",
    "itms-services://?action=download-manifest",
    "file:///etc/passwd",
    "not a url",
  ])("draws nothing for %s", (href) => {
    const html = renderToString(
      <LinkPreviewCard format="compact" href={href} site="example.com" title="A page" />,
    );
    expect(html).toBe("");
  });

  it("has no remote picture of its own", () => {
    const html = renderToString(
      <LinkPreviewCard
        format="large"
        href="https://example.com/a"
        site="example.com"
        title="A page"
        image={PICTURE}
      />,
    );

    expect(html).not.toMatch(/<img/);
    expect(html).not.toMatch(/background-image/);
    expect(html).not.toMatch(/src="https?:/);
  });
});

describe("LinkPreviewPicture", () => {
  it("fills its frame and crops by default", () => {
    const html = renderToString(<LinkPreviewPicture src="blob:a" />);
    expect(html).toContain('data-fit="cover"');
    expect(html).toContain("absolute inset-0");
    expect(html).toContain("object-cover");
    expect(html).not.toContain("object-contain");
    expect(html).not.toContain("p-link-icon-inset");
  });

  it("shows a site icon whole and centered, inset in its frame, never cropped", () => {
    const html = renderToString(<LinkPreviewPicture src="blob:a" fit="contain" />);
    expect(html).toContain('data-fit="contain"');
    expect(html).toContain("object-contain");
    expect(html).toContain("p-link-icon-inset");
    expect(html).not.toContain("object-cover");
  });
});
