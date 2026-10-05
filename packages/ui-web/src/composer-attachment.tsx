import { Paperclip, X } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

export interface ComposerAttachmentProps extends ComponentPropsWithoutRef<"div"> {
  /** File name: the image's alt text, or the truncated label on a file tile. */
  name: string;
  /** Present for an image — renders a thumbnail instead of the file tile. */
  previewUrl?: string;
  /** Accessible label for the × button, e.g. `Remove {name}` (the caller translates it). */
  removeLabel: string;
  onRemove?: () => void;
  /** Inert during dictation — the attachment stays visible, its × doesn't. */
  disabled?: boolean;
}

/**
 * A pending attachment (or a rewind artifact) inside the composer capsule: an
 * image thumbnail, or a file tile with a paperclip and a truncated name, each
 * with a × disc at its top end. Never widens the capsule — the file tile caps
 * out and truncates instead.
 */
export function ComposerAttachment({
  name,
  previewUrl,
  removeLabel,
  onRemove,
  disabled,
  className,
  ...props
}: ComposerAttachmentProps) {
  return (
    <div data-slot="composer-attachment" className={cn("relative flex-none", className)} {...props}>
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={name}
          className="size-composer-attachment-thumb rounded-card object-cover"
        />
      ) : (
        <div className="flex h-composer-attachment-thumb max-w-composer-attachment-tile items-center gap-2 rounded-card bg-secondary px-3.5 text-meta text-foreground">
          <Paperclip size={16} strokeWidth={1.8} className="shrink-0 text-muted-foreground" />
          <span className="truncate" dir="auto">
            {name}
          </span>
        </div>
      )}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        disabled={disabled}
        className="absolute -top-1.5 -end-1.5 grid size-composer-remove place-items-center rounded-full border-2 border-surface bg-primary text-primary-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <X size={11} strokeWidth={3} />
      </button>
    </div>
  );
}
