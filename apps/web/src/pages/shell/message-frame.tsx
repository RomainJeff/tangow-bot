import { useLingui } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import { isAsideOnlyMessage } from "@rakazo/core";
import type { ReactNode } from "react";
import { isHiddenActivityBlock } from "../../lib/message-blocks";

/**
 * How a thread frames a message, from the blocks it actually draws. An aside is a note between
 * messages: it gets no row chrome. A bot's question or approval is a normal row; aside is
 * decided by the blocks alone (a peer receipt is stored with role "user" but is still an aside).
 */
export function messageChrome(message: ThreadMessage, showSteps: boolean): "row" | "aside" {
  return isAsideOnlyMessage(
    message.blocks.filter((block) => !isHiddenActivityBlock(block, showSteps)),
  )
    ? "aside"
    : "row";
}

/** The two columns a row sits in: a user's right-aligned, a bot's across the thread. */
export function MessageFrame({
  message,
  chrome,
  children,
}: {
  message: ThreadMessage;
  chrome: "row" | "aside";
  children: ReactNode;
}) {
  return (
    <div
      className={
        chrome === "row"
          ? `relative flex ${message.role === "user" ? "justify-end" : "justify-start"}`
          : undefined
      }
    >
      <div
        data-testid={chrome === "row" ? "message-bubble-frame" : undefined}
        className={
          chrome === "row"
            ? // The pill floats at the row's own top-end corner (absolute, `end-3`),
              // so both rows run the full column width. A user row right-aligns its
              // bubble with `items-end` and caps it at 78% (`UserBubble`); the old
              // `w-fit` collapsed to the left once the bubble reached that 78% cap,
              // because fit-content resolves a percentage-capped child to full width.
              `relative min-w-0 w-full ${message.role === "user" ? "flex flex-col items-end" : ""}`
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}

/** Pages in the history that comes before what a thread shows. */
export function LoadEarlierButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      className="self-center rounded-row px-3 py-1.5 text-meta text-muted-foreground hover:bg-muted hover:text-foreground/75 disabled:opacity-50"
    >
      {loading ? t`Loading…` : t`Load earlier messages`}
    </button>
  );
}
