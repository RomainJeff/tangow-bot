import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadEntry } from "@rakazo/contracts";
import {
  computeMessageGroups,
  peerConversations,
  showsTimeMarker,
  stripPeerAddressPrefix,
  threadTimeMarkerLabel,
} from "@rakazo/core";
import { BotAvatar, Button, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { loadPeerHistory } from "../lib/peer-history";
import { rpc } from "../lib/rpc";
import { WindowChrome } from "./WindowChrome";

/**
 * Full-screen view-only transcript of a bot-to-bot exchange.
 * Opened from a Messaged / Message from chip in the human thread.
 */
export function PeerMessagesOverlay({
  botId,
  botName,
  botColor,
  botShapeSeed,
  peerBotId,
  peerBotName: initialPeerBotName,
  peerBotColor,
  peerBotShapeSeed,
  onClose,
}: {
  botId: string;
  botName: string;
  botColor: string;
  botShapeSeed?: number | null;
  peerBotId: string;
  peerBotName: string;
  peerBotColor: string;
  peerBotShapeSeed?: number | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [entries, setEntries] = useState<readonly ThreadEntry[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const conversation = useMemo(() => {
    if (!historyReady) return null;
    return peerConversations(entries).find((entry) => entry.peerBotId === peerBotId) ?? null;
  }, [historyReady, entries, peerBotId]);
  const peerBotName = conversation?.peerBotName ?? initialPeerBotName;
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Same grammar as the main thread's multi-bot grouping (rule R): consecutive
  // messages from the same side share one name/avatar. Both sides are "bot"
  // messages here — a peer exchange never shows the dark `chatUser` bubble —
  // and grouping keys on which bot actually sent each message.
  const peerGroups = useMemo(() => {
    const groupable = (conversation?.messages ?? []).map((peerMessage) => ({
      role: "bot" as const,
      botId: peerMessage.direction === "sent" ? botId : peerBotId,
      createdAt: peerMessage.createdAt,
      blocks: [{ kind: "text" as const, text: peerMessage.text }],
    }));
    return computeMessageGroups(groupable);
  }, [conversation, botId, peerBotId]);

  // Oldest-first order stays, but the view opens on the latest exchange.
  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element || !conversation) return;
    element.scrollTop = element.scrollHeight;
  }, [conversation]);

  useEffect(() => {
    const abort = new AbortController();
    setHistoryReady(false);
    setHistoryFailed(false);
    setEntries([]);
    void loadPeerHistory({
      signal: abort.signal,
      loadPage: (before, signal) =>
        rpc.threads.messages({ botId, before, includePeerRuns: true }, { signal }),
    })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setEntries(loaded);
        setHistoryReady(true);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setHistoryFailed(true);
        setHistoryReady(true);
      });
    return () => {
      abort.abort();
    };
  }, [botId, reloadKey]);

  const title = `${botName} · ${peerBotName}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="peer-conversation-view"
        showCloseButton={false}
        className="inset-0 top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground ring-0 sm:max-w-none"
      >
        <div className="app-drag flex items-center justify-between gap-4 border-b border-sidebar-border px-[18px] py-3.5">
          <div className="app-no-drag flex min-w-0 flex-1 items-center gap-3">
            {/* The overlay covers the shell header, so it reserves room for the window controls itself. */}
            {desktopBridge() ? <WindowChrome /> : null}
            <div className="flex items-center -space-x-2">
              <BotAvatar color={botColor} identity={botId} shapeSeed={botShapeSeed} size={28} />
              <BotAvatar
                color={peerBotColor}
                identity={peerBotId}
                shapeSeed={peerBotShapeSeed}
                size={28}
              />
            </div>
            <DialogTitle className="truncate text-[15.5px] font-medium text-foreground" dir="auto">
              {title}
            </DialogTitle>
          </div>
          <DialogClose
            aria-label={t`Close`}
            render={<Button variant="ghost" size="sm" className="app-no-drag" />}
          >
            <Trans>Close</Trans>
          </DialogClose>
        </div>

        {!historyReady ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>Loading…</Trans>
          </div>
        ) : historyFailed ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <div className="flex flex-col items-center gap-3">
              <Trans>Could not load this chat.</Trans>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <Trans>Retry now</Trans>
              </Button>
            </div>
          </div>
        ) : !conversation || conversation.messages.length === 0 ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-muted-foreground/80">
            <Trans>No messages with {peerBotName} yet.</Trans>
          </div>
        ) : (
          <div
            ref={transcriptRef}
            data-testid="peer-conversation-transcript"
            className="rk-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 py-5 md:px-7 md:py-6"
          >
            {conversation.messages.map((peerMessage, index) => {
              const group = peerGroups[index]!;
              const sent = peerMessage.direction === "sent";
              const name = sent ? botName : peerBotName;
              const color = sent ? botColor : peerBotColor;
              const shapeSeed = sent ? botShapeSeed : peerBotShapeSeed;
              const identity = sent ? botId : peerBotId;
              const timeMarker = showsTimeMarker(
                conversation.messages[index - 1]?.createdAt,
                peerMessage.createdAt,
              )
                ? threadTimeMarkerLabel(peerMessage.createdAt, {
                    locale: i18n.locale || "en",
                    today: t`Today`,
                    yesterday: t`Yesterday`,
                  })
                : "";
              return (
                <Fragment key={`${peerMessage.messageId}-${index}`}>
                  {timeMarker ? (
                    <time
                      dateTime={peerMessage.createdAt}
                      className="self-center text-label tabular-nums text-muted-foreground"
                    >
                      {timeMarker}
                    </time>
                  ) : null}
                  {/* 14px between groups (the container's own `gap-3.5`),
                      narrowed to 3px within a group. Both sides render on the
                      left, in `muted` bubbles — never the dark `chatUser`
                      fill, which is reserved for the human. */}
                  <div className={`flex items-end gap-2${group.isFirstOfGroup ? "" : " -mt-2.75"}`}>
                    <div className="w-message shrink-0">
                      {group.isLastOfGroup ? (
                        <BotAvatar
                          color={color}
                          identity={identity}
                          shapeSeed={shapeSeed}
                          size={26}
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      {group.isFirstOfGroup ? (
                        <div className="mb-0.25 ps-3">
                          <span className="text-author text-foreground" dir="auto">
                            {name}
                          </span>
                        </div>
                      ) : null}
                      <div
                        data-slot="message-row-bubble"
                        className="w-fit max-w-22/25 rounded-bubble bg-chat-bot px-3.5 py-2.5 text-foreground shadow-bubble"
                        dir="auto"
                      >
                        <ChatMarkdown>{stripPeerAddressPrefix(peerMessage.text)}</ChatMarkdown>
                      </div>
                    </div>
                  </div>
                </Fragment>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-4 border-t border-sidebar-border px-[18px] py-3.5">
          <p className="text-[13.5px] text-muted-foreground/80">
            <Trans>This chat is view-only</Trans>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
