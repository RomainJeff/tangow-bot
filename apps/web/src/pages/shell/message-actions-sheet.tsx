import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import { canReactToThreadMessage, MESSAGE_REACTIONS } from "@rakazo/contracts";
import { ActionSheet } from "@rakazo/ui-web";
import { Copy, Pencil, Reply, Square, Volume2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  canEditAndResendMessage,
  canSpeakMessage,
  copyMessageToClipboard,
} from "./message-actions";

interface ActionRow {
  key: string;
  label: ReactNode;
  icon: ReactNode;
  onSelect: () => void;
}

/**
 * The touch long-press sheet for a thread message (`transcript.tsx`): quick
 * reactions, then its actions — same handlers as the hover pill
 * (`message-hover-actions.tsx`, via `./message-actions`), same order (Reply,
 * Copy, Speak/Stop, Edit and resend), so the two surfaces never drift.
 * Mirrors the mobile app's `MessageActionsSheet` content, built on the web's
 * own `ActionSheet` primitive instead of the native sheet host.
 */
export function MessageActionsSheet({
  message,
  open,
  onOpenChange,
  onReply,
  onEdit,
  onReact,
  voiceReady,
  speaking,
  onSpeak,
}: {
  message: ThreadMessage | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReply: (message: ThreadMessage) => void;
  onEdit: (message: ThreadMessage) => void;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  voiceReady: boolean;
  speaking: boolean;
  onSpeak: (message: ThreadMessage) => void;
}) {
  const { t } = useLingui();

  function close() {
    onOpenChange(false);
  }

  function runAndClose(action: () => void) {
    close();
    action();
  }

  const rows: ActionRow[] = message
    ? [
        {
          key: "reply",
          label: t`Reply`,
          icon: <Reply size={18} strokeWidth={1.7} aria-hidden="true" />,
          onSelect: () => onReply(message),
        },
        {
          key: "copy",
          label: t`Copy`,
          icon: <Copy size={18} strokeWidth={1.7} aria-hidden="true" />,
          onSelect: () => copyMessageToClipboard(message),
        },
        ...(canSpeakMessage(message, voiceReady)
          ? [
              {
                key: "speak",
                label: speaking ? t`Stop speaking` : t`Speak this reply`,
                icon: speaking ? (
                  <Square size={16} strokeWidth={1.7} aria-hidden="true" />
                ) : (
                  <Volume2 size={18} strokeWidth={1.7} aria-hidden="true" />
                ),
                onSelect: () => onSpeak(message),
              },
            ]
          : []),
        ...(canEditAndResendMessage(message)
          ? [
              {
                key: "edit",
                label: <Trans>Edit and resend</Trans>,
                icon: <Pencil size={18} strokeWidth={1.7} aria-hidden="true" />,
                onSelect: () => onEdit(message),
              },
            ]
          : []),
      ]
    : [];

  return (
    <ActionSheet
      open={open && message !== null}
      onOpenChange={onOpenChange}
      title={t`Message actions`}
    >
      {message && canReactToThreadMessage(message) ? (
        <fieldset className="flex items-center justify-between px-4 pt-1 pb-3">
          <legend className="sr-only">{t`Reactions`}</legend>
          {MESSAGE_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={emoji}
              className="grid size-11 shrink-0 place-items-center rounded-full text-2xl duration-(--duration-hover) ease-quiet hover:bg-accent"
              onClick={() => runAndClose(() => void onReact(message, emoji))}
            >
              {emoji}
            </button>
          ))}
        </fieldset>
      ) : null}
      <div className="mx-4 divide-y divide-border overflow-hidden rounded-card border border-border">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            className="flex min-h-13 w-full items-center gap-3.5 px-4 text-start text-body text-foreground duration-(--duration-hover) ease-quiet hover:bg-accent"
            onClick={() => runAndClose(row.onSelect)}
          >
            {row.icon}
            {row.label}
          </button>
        ))}
      </div>
    </ActionSheet>
  );
}
