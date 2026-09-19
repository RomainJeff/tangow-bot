import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import { canReactToThreadMessage, MESSAGE_REACTIONS } from "@rakazo/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  HoverPill,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { Copy, MoreHorizontal, Pencil, Reply, Smile, Square, Volume2 } from "lucide-react";
import { useState } from "react";
import { copyableMessageText } from "../../lib/message-text";

export function MessageHoverActions({
  message,
  revealed,
  side,
  onReply,
  onEdit,
  onReact,
  voiceReady,
  speaking,
  onSpeak,
}: {
  message: ThreadMessage;
  /** Force the pill open on a touch tap, which has no hover to reveal it. */
  revealed?: boolean;
  side: "start" | "end";
  onReply: (message: ThreadMessage) => void;
  onEdit: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
}) {
  const { t } = useLingui();
  const [moreOpen, setMoreOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);

  // Streaming progress bubbles keep hover free for selection / stop clicks.
  if (message.id.startsWith("progress:")) return null;

  function copyMessage() {
    const text = copyableMessageText(message);
    if (!text || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }

  const canSpeak = voiceReady && message.blocks.some((block) => block.kind === "text");
  const isUser = message.role === "user";
  // A popover or menu can move focus into a portal outside the row, which
  // would otherwise let the pill fade under the open surface it anchors. A
  // touch tap reveals it the same way, since touch has no hover.
  const pinned = moreOpen || reactionsOpen || revealed === true;
  // Revealed by a touch tap, the buttons carry 44pt touch targets; on hover
  // (fine pointer) they stay the compact pill size.
  const iconClass = `grid ${
    revealed ? "size-11" : "size-hover-icon"
  } shrink-0 place-items-center rounded-full text-muted-foreground duration-(--duration-hover) ease-quiet rk-press-round hover:bg-accent hover:text-foreground`;

  return (
    <HoverPill
      data-testid="message-hover-rail"
      style={pinned ? { opacity: 1, pointerEvents: "auto" } : undefined}
    >
      <div data-testid="message-hover-actions" className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={t`Reply`}
          onClick={() => onReply(message)}
          className={iconClass}
        >
          <Reply size={15} strokeWidth={1.7} />
        </button>
        {canReactToThreadMessage(message) ? (
          <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}>
            <PopoverTrigger aria-label={t`React`} className={iconClass}>
              <Smile size={15} strokeWidth={1.7} />
            </PopoverTrigger>
            <PopoverContent
              align={side === "end" ? "start" : "end"}
              className="w-auto flex-row gap-0 rounded-card p-1.5"
              aria-label={t`Reactions`}
            >
              {MESSAGE_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={emoji}
                  className="grid h-11 w-11 place-items-center rounded-row text-2xl hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setReactionsOpen(false);
                    void onReact(message, emoji);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        <button type="button" aria-label={t`Copy`} onClick={copyMessage} className={iconClass}>
          <Copy size={14} strokeWidth={1.7} />
        </button>
        {canSpeak ? (
          <button
            type="button"
            aria-label={speaking ? t`Stop speaking` : t`Speak this reply`}
            onClick={onSpeak}
            className={iconClass}
          >
            {speaking ? (
              <Square size={13} strokeWidth={1.7} />
            ) : (
              <Volume2 size={15} strokeWidth={1.7} />
            )}
          </button>
        ) : null}
        {isUser ? (
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger aria-label={t`More`} className={iconClass}>
              <MoreHorizontal size={15} strokeWidth={1.7} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align={side === "end" ? "start" : "end"}>
              <DropdownMenuItem data-testid="message-edit" onClick={() => onEdit(message)}>
                <Pencil size={15} />
                <Trans>Edit and resend</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </HoverPill>
  );
}
