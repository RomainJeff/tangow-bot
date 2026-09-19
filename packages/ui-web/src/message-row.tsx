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
  time?: ReactNode;
  children: ReactNode;
  meta?: MessageRowMeta;
  /** Overlay anchored to the row, typically a `HoverPill`. */
  trailing?: ReactNode;
  /** True when this row continues the previous message's group: the avatar,
   * author and time are suppressed and `time` (if given) only reveals on
   * hover/focus, in the gutter that would otherwise hold the avatar. */
  continued?: boolean;
}

/**
 * A bot message: avatar, name, time, prose. No fill, no border — the thread
 * frames nothing except a decision.
 */
export function MessageRow({
  avatar,
  author,
  time,
  children,
  meta,
  trailing,
  continued,
  className,
  ...props
}: MessageRowProps) {
  return (
    <div
      data-slot="message-row"
      data-continued={continued ? "true" : undefined}
      className={cn("group relative flex gap-3.5", className)}
      {...props}
    >
      <div data-slot="message-row-avatar" className="w-message shrink-0 relative">
        {continued ? (
          time ? (
            <span
              data-slot="message-row-time"
              className="pointer-events-none absolute end-1 top-0 text-time text-muted-foreground tabular-nums opacity-0 duration-(--duration-hover) ease-quiet group-hover:opacity-100 group-focus-within:opacity-100"
            >
              {time}
            </span>
          ) : null
        ) : (
          avatar
        )}
      </div>
      <div className="min-w-0 flex-1">
        {continued ? null : (
          <div className="mb-0.75 flex items-baseline gap-1.75">
            <span data-slot="message-row-author" className="text-author text-foreground">
              {author}
            </span>
            {time ? (
              <span data-slot="message-row-time" className="text-time text-muted-foreground">
                {time}
              </span>
            ) : null}
          </div>
        )}
        <div data-slot="message-row-body" className="text-body text-pretty text-foreground">
          {children}
        </div>
        {meta ? (
          <button
            type="button"
            data-slot="message-row-meta"
            onClick={meta.onClick}
            className="mt-1.75 flex items-center gap-1 text-meta text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground"
          >
            {meta.label}
            <ChevronRight aria-hidden="true" className="size-3" />
          </button>
        ) : null}
      </div>
      {trailing}
    </div>
  );
}
