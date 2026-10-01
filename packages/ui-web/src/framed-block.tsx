import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";

export interface FramedBlockHeader {
  /** Who is asking, already translated by the caller. */
  who: ReactNode;
  /** Ink dot in front of the header — the bot needs an answer. */
  dot?: boolean;
}

export interface FramedBlockProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** Omitted when the row above already names who is asking (a bot row's
   * author line) — the question then opens the card with no header line. */
  header?: FramedBlockHeader;
  question: ReactNode;
  /** What pressing the primary action will do, one line under the question. */
  consequence?: ReactNode;
  /** Controls between the question and the actions (options, a text field). */
  children?: ReactNode;
  /** Capsules. */
  actions?: ReactNode;
  /**
   * The answer that was given. Once set the block is settled: the controls and
   * the actions are gone and only this line remains, so nothing looks pressable
   * that is not.
   */
  answered?: ReactNode;
}

/**
 * The only framed element of the thread: a decision or a question the bot
 * cannot make alone.
 */
export function FramedBlock({
  header,
  question,
  consequence,
  children,
  actions,
  answered,
  className,
  ...props
}: FramedBlockProps) {
  return (
    <div
      data-slot="framed-block"
      data-answered={answered ? "true" : undefined}
      className={cn(
        "overflow-hidden rounded-block bg-surface",
        answered ? "shadow-settled" : "shadow-card",
        className,
      )}
      {...props}
    >
      {header ? (
        <div
          data-slot="framed-block-header"
          className="flex items-center gap-2 px-3.5 pt-3 text-block-header text-muted-foreground"
        >
          {header.dot ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-foreground" />
          ) : null}
          <span className="min-w-0 truncate">{header.who}</span>
        </div>
      ) : null}
      <div
        data-slot="framed-block-question"
        className={cn("px-3.5 text-question text-foreground", header ? "pt-2" : "pt-3")}
      >
        {question}
      </div>
      {consequence ? (
        <div
          data-slot="framed-block-consequence"
          className="px-3.5 pt-1.5 text-meta text-muted-foreground"
        >
          {consequence}
        </div>
      ) : null}
      {answered ? (
        <div
          data-slot="framed-block-answered"
          className="px-3.5 py-3 text-meta text-muted-foreground"
        >
          {answered}
        </div>
      ) : (
        <>
          {children ? (
            <div data-slot="framed-block-body" className="px-3.5 pt-3">
              {children}
            </div>
          ) : null}
          {actions ? (
            <div data-slot="framed-block-actions" className="flex flex-wrap gap-2 p-3.5">
              {actions}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
