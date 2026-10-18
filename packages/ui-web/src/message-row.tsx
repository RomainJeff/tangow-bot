import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";

export interface MessageRowMeta {
  /** The proof line, already translated ("Sent to #ops", "2 sources"). One line, truncated. */
  label: ReactNode;
  /** Leading icon, 14px, in the line's muted colour. Decorative: the label is the name. */
  icon?: ReactNode;
  onClick?: () => void;
  className?: string;
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
  /** The proof lines, drawn inside the bubble under its content, one under the other. */
  meta?: MessageRowMeta | MessageRowMeta[];
}

/**
 * Proof lines stacked left, outside any bubble's content so a bot's own text can never pass
 * for one. A line with an `onClick` is a link named by its label, as on iPhone.
 */
export function MessageMeta({
  lines,
  className,
}: {
  lines: MessageRowMeta | MessageRowMeta[];
  className?: string;
}) {
  const list = Array.isArray(lines) ? lines : [lines];
  if (list.length === 0) return null;
  return (
    <div className={cn("flex flex-col items-start gap-1.5", className)}>
      {list.map((line, i) => {
        const content = (
          <>
            {line.icon}
            <span className="min-w-0 truncate">{line.label}</span>
          </>
        );
        return line.onClick ? (
          // biome-ignore lint/a11y/useSemanticElements: it opens a panel, not an address; it reads as the link it is on iPhone
          <button
            key={i}
            type="button"
            role="link"
            data-slot="message-row-meta"
            onClick={line.onClick}
            className={cn(
              "flex max-w-full items-center gap-1 text-meta text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground",
              line.className,
            )}
          >
            {content}
            <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
          </button>
        ) : (
          <div
            key={i}
            data-slot="message-row-meta"
            className={cn(
              "flex max-w-full items-center gap-1 text-meta text-muted-foreground",
              line.className,
            )}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
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
        "w-fit rounded-bubble bg-chat-bot px-3.5 py-2.5 text-foreground shadow-bubble",
        inGroup ? "max-w-22/25" : "max-w-41/50",
        className,
      )}
      {...props}
    >
      {children}
      {meta ? <MessageMeta lines={meta} className="mt-1.5" /> : null}
    </div>
  );
}
