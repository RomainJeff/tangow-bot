import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";

export interface FramedBlockHeader {
  /** Who is asking, already translated by the caller. */
  who: ReactNode;
  /** Ink dot in front of the header — the bot needs an answer. */
  dot?: boolean;
}

export type FramedBlockActionsAlign = "end" | "start";

const ACTIONS_ALIGN_CLASS: Record<FramedBlockActionsAlign, string> = {
  end: "justify-end",
  start: "justify-start",
};

export interface FramedBlockProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** Omitted when the row above already names who is asking (a bot row's
   * author line) — the question then opens the card with no header line. */
  header?: FramedBlockHeader;
  question: ReactNode;
  /** What pressing the primary action will do, one line under the question. */
  consequence?: ReactNode;
  /** Controls between the question and the actions (options, a text field). */
  children?: ReactNode;
  /** Capsules, ordered dismiss, secondary, primary: the primary is always last. */
  actions?: ReactNode;
  /**
   * Where the actions sit. `end` (default) is a decision to validate: the group
   * hugs the right edge, primary rightmost. `start` is a list of answers to
   * read, which stays on the left.
   */
  actionsAlign?: FramedBlockActionsAlign;
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
  actionsAlign = "end",
  answered,
  className,
  ...props
}: FramedBlockProps) {
  return (
    <div
      data-slot="framed-block"
      data-answered={answered ? "true" : undefined}
      className={cn(
        "flex flex-col overflow-hidden",
        // Answered, the card drops back onto the bot's paper and gives the thread its elevation back.
        answered
          ? "w-fit max-w-41/50 gap-1 rounded-bubble bg-chat-bot px-4 py-3 shadow-settled"
          : "gap-2 rounded-block bg-surface p-5 shadow-card",
        className,
      )}
      {...props}
    >
      {header ? (
        <div
          data-slot="framed-block-header"
          className="flex items-center gap-2 text-block-header text-muted-foreground"
        >
          {header.dot ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-foreground" />
          ) : null}
          <span className="min-w-0 truncate">{header.who}</span>
        </div>
      ) : null}
      <div
        data-slot="framed-block-question"
        className={cn("text-foreground", answered ? "text-body font-medium" : "text-question")}
      >
        {question}
      </div>
      {consequence ? (
        <div data-slot="framed-block-consequence" className="text-meta text-muted-foreground">
          {consequence}
        </div>
      ) : null}
      {answered ? (
        <div data-slot="framed-block-answered" className="text-meta text-muted-foreground">
          {answered}
        </div>
      ) : (
        <>
          {children ? (
            <div data-slot="framed-block-body" className="pt-1">
              {children}
            </div>
          ) : null}
          {actions ? (
            <div
              data-slot="framed-block-actions"
              data-align={actionsAlign}
              className={cn("flex flex-wrap gap-2 pt-2", ACTIONS_ALIGN_CLASS[actionsAlign])}
            >
              {actions}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
