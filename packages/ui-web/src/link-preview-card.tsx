import { linkLargeImageRatio } from "@rakazo/ui-tokens";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";
import { Surface } from "./surface.js";

export type LinkPreviewFormat = "large" | "photo" | "compact";

export interface LinkPreviewCardProps
  extends Omit<ComponentPropsWithoutRef<"a">, "href" | "title" | "children" | "onClick"> {
  /** The link as sent: the card opens it, and renders nothing unless it is http(s). */
  href: string;
  /** The host of `href`, already derived and never truncated from the end. */
  site: string;
  /** Plain text, already sanitized. A photo has none. */
  title?: string;
  format: LinkPreviewFormat;
  /**
   * The picture, filling its frame (`absolute inset-0`). Never a remote URL: it comes from an
   * artifact of the thread, so opening a thread contacts no third-party site.
   */
  image?: ReactNode;
  /** Width over height of a `photo`, so its frame keeps the picture's proportions. */
  imageRatio?: number;
  onOpen?: () => void;
}

/**
 * A preview picture that fills its frame (`absolute inset-0`). By default it is cropped at the
 * center (`object-cover`); a site icon (`fit="contain"`) is shown whole, centered, with the
 * `linkIconInset` token around it, so the icon is never cut and breathes inside the thumbnail's `secondary` tile.
 */
export function LinkPreviewPicture({
  src,
  fit,
  className,
}: {
  src: string;
  fit?: "contain";
  className?: string;
}) {
  const whole = fit === "contain";
  return (
    <div
      data-slot="link-preview-picture"
      data-fit={whole ? "contain" : "cover"}
      className={cn("absolute inset-0", whole && "p-link-icon-inset", className)}
    >
      <img
        src={src}
        alt=""
        className={cn("size-full", whole ? "object-contain" : "object-cover")}
      />
    </div>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function Site({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-meta text-muted-foreground wrap-anywhere", className)}>
      <bdi dir="ltr">{children}</bdi>
    </div>
  );
}

/**
 * What the page a link points to looks like: one card, three formats. The whole card is the
 * link (an `<a>`, name "title, site"), the picture is decorative, and the card never carries a
 * shadow or any control of its own: the actions of the message act on it. Renders nothing for a
 * non-http(s) `href`, so a `javascript:` or `tel:` URL can never become clickable.
 */
export function LinkPreviewCard({
  href,
  site,
  title,
  format,
  image,
  imageRatio,
  onOpen,
  className,
  ...props
}: LinkPreviewCardProps) {
  if (!isHttpUrl(href)) return null;
  const label = format === "photo" || !title ? site : `${title}, ${site}`;
  const titleLine = title ? (
    <div
      className="line-clamp-2 text-row-name font-medium text-foreground wrap-anywhere"
      dir="auto"
    >
      <bdi>{title}</bdi>
    </div>
  ) : null;
  return (
    <a
      data-slot="link-preview-card"
      data-format={format}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label}
      onClick={onOpen}
      className={cn(
        "group/link-card block w-link-card max-w-full animate-arrive rounded-card text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    >
      {format === "photo" ? (
        <>
          <div
            className="relative max-h-link-photo-max w-full overflow-hidden rounded-bubble bg-secondary"
            style={{ aspectRatio: imageRatio ?? linkLargeImageRatio }}
          >
            {image}
          </div>
          <Site className="mt-1 px-1">{site}</Site>
        </>
      ) : (
        <Surface
          className={cn(
            "overflow-hidden transition-colors duration-(--duration-hover) ease-quiet group-hover/link-card:border-outline",
            format === "compact" && "flex items-center gap-2.5 py-2 pe-3",
            format === "compact" && (image ? "ps-2" : "ps-3"),
          )}
        >
          {format === "large" ? (
            <>
              <div
                className="relative w-full bg-secondary"
                style={{ aspectRatio: linkLargeImageRatio }}
              >
                {image}
              </div>
              <div className="px-3 py-2.5">
                {titleLine}
                <Site>{site}</Site>
              </div>
            </>
          ) : (
            <>
              {image ? (
                <div className="relative size-link-thumb shrink-0 overflow-hidden rounded-chip bg-secondary">
                  {image}
                </div>
              ) : null}
              <div className="min-w-0">
                {titleLine}
                <Site>{site}</Site>
              </div>
            </>
          )}
        </Surface>
      )}
    </a>
  );
}
