import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";

export interface MessageRowMeta {
  /** The proof line, already translated ("Sent to #ops", "2 sources"). */
  label: ReactNode;
  onClick?: () => void;
}

export interface MessageRowProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  avatar: ReactNode;
  author: ReactNode;
  children: ReactNode;
  /** Overlay anchored to the row, typically a `HoverPill`. */
  trailing?: ReactNode;
  /** Show the author name above this message: the first message of a group in
   * a multi-bot thread (`computeMessageGroups`'s `isFirstOfGroup`). A mono
   * thread (`hasAvatarColumn` false) never passes this. Defaults to true. */
  showAuthor?: boolean;
  /** Show the avatar for this message: the last message of a group in a
   * multi-bot thread (`isLastOfGroup`). `items-end` on the row bottom-aligns
   * it with the last bubble; the other messages of the group leave the
   * avatar column reserved but empty, so later bubbles keep the same
   * indent. Defaults to true. */
  showAvatar?: boolean;
  /** Whether this row reserves an avatar-column gutter at all. False — a
   * single-bot ("mono") thread — removes it entirely: the bubble starts
   * flush at the thread's own edge, with no name and no avatar ever shown.
   * Defaults to true (multi-bot threads). */
  hasAvatarColumn?: boolean;
}

/**
 * A bot message: a `muted` bubble (the caller's own `children`), with the
 * avatar and name shared across a group of consecutive messages from the
 * same bot (see `computeMessageGroups`) instead of repeated on every row.
 * The row itself carries no fill or border; the bubble is a `MessageBubble` child.
 */
export function MessageRow({
  avatar,
  author,
  children,
  trailing,
  showAuthor = true,
  showAvatar = true,
  hasAvatarColumn = true,
  className,
  ...props
}: MessageRowProps) {
  return (
    <div
      data-slot="message-row"
      className={cn("group relative flex items-end gap-2", className)}
      {...props}
    >
      {hasAvatarColumn ? (
        <div data-slot="message-row-avatar" className="w-message shrink-0">
          {showAvatar ? avatar : null}
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        {showAuthor ? (
          <div className="mb-0.25 ps-3">
            <span data-slot="message-row-author" className="text-author text-foreground">
              {author}
            </span>
          </div>
        ) : null}
        <div data-slot="message-row-body" className="text-body text-pretty text-foreground">
          {children}
        </div>
      </div>
      {trailing}
    </div>
  );
}

export interface MessageBubbleProps extends ComponentPropsWithoutRef<"div"> {
  /** A multi-bot thread: the bubble caps at 88% of the content column instead of 82%. */
  inGroup?: boolean;
  /** The proof line, drawn inside the bubble under its content. */
  meta?: MessageRowMeta;
}

/**
 * What a bot said: a `muted` bubble that fits its content. The `data-slot`
 * scopes the markdown-in-a-bubble rules of `markdown.web.css`.
 */
export function MessageBubble({
  inGroup,
  meta,
  className,
  children,
  ...props
}: MessageBubbleProps) {
  return (
    <div
      data-slot="message-row-bubble"
      // Fractions rather than arbitrary widths: 41/50 is 82%, 22/25 is 88%.
      className={cn(
        "w-fit rounded-bubble bg-muted px-3.5 py-2.5 text-foreground",
        inGroup ? "max-w-22/25" : "max-w-41/50",
        className,
      )}
      {...props}
    >
      {children}
      {meta ? (
        <button
          type="button"
          data-slot="message-row-meta"
          onClick={meta.onClick}
          className="mt-1.5 flex items-center gap-1 text-meta text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground"
        >
          {meta.label}
          <ChevronRight aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
