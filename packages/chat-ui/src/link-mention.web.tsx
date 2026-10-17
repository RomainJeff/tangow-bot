import type { LinkMentionResolver } from "@rakazo/core";
import { linkMentionLabel, previewSiteLabel } from "@rakazo/core";
import type { ReactNode } from "react";

/** The neutral link glyph (lucide `link`) on its tile, for a site without a usable icon. */
export function LinkMentionGlyph() {
  return (
    <span data-slot="link-mention-glyph" className="rk-link-mention-glyph">
      <svg
        width="62.5%"
        height="62.5%"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </span>
  );
}

/** The URL as the browser will open it: an internationalised host in its punycode form. */
function asciiHref(href: string): string {
  try {
    return new URL(href).href;
  } catch {
    return href;
  }
}

/**
 * A link shown as its site's icon and a readable label, in place in the sentence. The label is
 * inert, bidi-isolated text that ends in an ellipsis rather than widen the bubble; the full URL is
 * its tooltip and the host completes its accessible name, since the label alone can say anything.
 */
function LinkMention({
  href,
  label,
  site,
  icon,
  className,
}: {
  href: string;
  label: string;
  /** The host of `href` (`previewSiteLabel`), never shortened. */
  site: string;
  /** The site icon, filling a 16 px frame; the link glyph stands in when absent. */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <a
      data-slot="link-mention"
      className={className ? `rk-link-mention ${className}` : "rk-link-mention"}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={asciiHref(href)}
      aria-label={label === site ? site : `${label}, ${site}`}
    >
      <span className="rk-link-mention-icon" aria-hidden="true">
        {icon ?? <LinkMentionGlyph />}
      </span>
      <bdi className="rk-link-mention-label">{label}</bdi>
    </a>
  );
}

/** The mention a link of this message resolves to, or undefined when it stays a plain link. */
export function resolvedLinkMention(
  mentions: LinkMentionResolver<ReactNode> | undefined,
  href: string | undefined,
  authorText: string,
  className?: string,
): ReactNode | undefined {
  const block = href ? mentions?.find(href) : undefined;
  if (!mentions || !href || !block) return undefined;
  return (
    <LinkMention
      href={href}
      label={linkMentionLabel({ href, authorText, block })}
      site={previewSiteLabel(href)}
      icon={block.icon ? mentions.icon(block.icon.artifactId) : undefined}
      className={className}
    />
  );
}
