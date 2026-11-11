import { useLingui } from "@lingui/react/macro";
import type { MessageReaction } from "@rakazo/contracts";
import { canReactToThreadMessage, MESSAGE_REACTIONS } from "@rakazo/contracts";
import { HoverPill, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Copy, Link2Off, Pencil, Reply, Smile, Square, Volume2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { MessageItem } from "../../lib/thread-items";
import { isLiveItem } from "../../lib/thread-items";
import {
  canEditAndResendMessage,
  canRemoveLinkPreview,
  canSpeakMessage,
  copyMessageToClipboard,
  removeLinkPreview,
} from "./message-actions";

const iconClass =
  "grid size-hover-icon shrink-0 place-items-center rounded-full text-muted-foreground duration-(--duration-hover) ease-quiet rk-press-round hover:bg-accent hover:text-foreground";

export function MessageHoverActions({
  message,
  previewMessageId,
  onReply,
  onReact,
  voiceReady,
  speaking,
  onSpeak,
  time,
}: {
  message: MessageItem;
  previewMessageId?: string;
  /** The message's time, shown ahead of the actions. */
  time?: ReactNode;
  onReply: (message: MessageItem) => void;
  onReact: (message: MessageItem, reaction: MessageReaction) => Promise<void>;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: () => void;
}) {
  const { t } = useLingui();
  const [reactionsOpen, setReactionsOpen] = useState(false);

  // Streaming progress bubbles keep hover free for selection / stop clicks.
  if (isLiveItem(message)) return null;

  const canSpeak = canSpeakMessage(message, voiceReady);
  // The reaction popover moves focus into a portal outside the row, which
  // would otherwise let the pill fade under the open surface it anchors.
  const pinned = reactionsOpen;

  return (
    <HoverPill
      data-testid="message-hover-rail"
      style={pinned ? { opacity: 1, pointerEvents: "auto" } : undefined}
    >
      {time ? (
        <span className="ps-2 pe-1 text-time tabular-nums text-muted-foreground">{time}</span>
      ) : null}
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
              align="start"
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
        <button
          type="button"
          aria-label={t`Copy`}
          onClick={() => copyMessageToClipboard(message)}
          className={iconClass}
        >
          <Copy size={14} strokeWidth={1.7} />
        </button>
        {previewMessageId && canRemoveLinkPreview(message) ? (
          <button
            type="button"
            aria-label={t`Remove preview`}
            title={t`Remove preview`}
            onClick={() => removeLinkPreview(previewMessageId)}
            className={iconClass}
          >
            <Link2Off size={14} strokeWidth={1.7} />
          </button>
        ) : null}
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
      </div>
    </HoverPill>
  );
}

/**
 * Your own message's actions, under its bubble on hover or keyboard focus:
 * Edit and resend, then Copy. Bare icons, no pill — nothing to reply or react
 * to on what you said yourself. Floats below the row (`top-full`) so it never
 * moves the thread; the row's `hover:z-20` keeps it above the next message.
 */
export function UserMessageActions({
  message,
  previewMessageId,
  onEdit,
}: {
  message: MessageItem;
  previewMessageId?: string;
  /** Absent where the history is not only yours to rewrite: a group of several people. */
  onEdit?: (message: MessageItem) => void;
}) {
  const { t } = useLingui();
  if (isLiveItem(message)) return null;
  return (
    <div
      data-testid="message-user-actions"
      className="pointer-events-none absolute end-0 top-full z-10 flex items-center gap-0.5 opacity-0 transition-opacity duration-(--duration-hover) ease-quiet group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-has-[:focus-visible]/message:pointer-events-auto group-has-[:focus-visible]/message:opacity-100"
    >
      {onEdit && canEditAndResendMessage(message) ? (
        <button
          type="button"
          data-testid="message-edit"
          aria-label={t`Edit and resend`}
          onClick={() => onEdit(message)}
          className={iconClass}
        >
          <Pencil size={14} strokeWidth={1.7} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t`Copy`}
        onClick={() => copyMessageToClipboard(message)}
        className={iconClass}
      >
        <Copy size={14} strokeWidth={1.7} />
      </button>
      {previewMessageId && canRemoveLinkPreview(message) ? (
        <button
          type="button"
          aria-label={t`Remove preview`}
          title={t`Remove preview`}
          onClick={() => removeLinkPreview(previewMessageId)}
          className={iconClass}
        >
          <Link2Off size={14} strokeWidth={1.7} />
        </button>
      ) : null}
    </div>
  );
}
