import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { ComposerRemoveButton } from "./composer-attachment.js";
import { cn } from "./lib/utils.js";
import { Shimmer } from "./shimmer.js";

export interface ComposerLinkPreviewProps extends ComponentPropsWithoutRef<"div"> {
  /** A read in progress: the host sweeps in `Shimmer` while the page is read, nothing else moves. */
  loading?: boolean;
  /** The host of the link, derived by `previewSiteLabel`. */
  site?: string;
  /** Plain text, already sanitized. */
  title?: string;
  /**
   * The picture, filling its frame (`absolute inset-0`). Only ever the inline thumbnail the server
   * returned, never a remote URL.
   */
  image?: ReactNode;
  /** Accessible label for the × button (the caller translates it). */
  removeLabel: string;
  onRemove?: () => void;
  /** Inert during dictation, like the attachments. */
  disabled?: boolean;
}

/**
 * What a link in the draft will look like, inside the composer capsule next to its attachments:
 * always the compact card, whatever format the server picked, so the composer stays small. Not a
 * link (the card opens nothing here); its × takes the preview off this message.
 */
export function ComposerLinkPreview({
  loading,
  site,
  title,
  image,
  removeLabel,
  onRemove,
  disabled,
  className,
  ...props
}: ComposerLinkPreviewProps) {
  return (
    <div
      data-slot="composer-link-preview"
      data-state={loading ? "loading" : "ready"}
      className={cn("relative flex-none", className)}
      {...props}
    >
      <div className="flex h-composer-attachment-thumb max-w-link-card items-center gap-2.5 rounded-card bg-background p-1 pe-3">
        {loading || image ? (
          <div
            aria-hidden
            className="relative size-link-thumb shrink-0 overflow-hidden rounded-chip bg-secondary"
          >
            {loading ? null : image}
          </div>
        ) : (
          <div className="w-2 shrink-0" />
        )}
        <div className="min-w-0">
          {title && !loading ? (
            <div className="truncate text-row-name font-medium text-foreground" dir="auto">
              <bdi>{title}</bdi>
            </div>
          ) : null}
          <div className="truncate text-meta text-muted-foreground">
            <bdi dir="ltr">{loading ? <Shimmer>{site}</Shimmer> : site}</bdi>
          </div>
        </div>
      </div>
      <ComposerRemoveButton label={removeLabel} onClick={onRemove} disabled={disabled} />
    </div>
  );
}
