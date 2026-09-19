import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import {
  computeGroupContinuations,
  isAsideOnlyMessage,
  isToolActivityBlock,
  latestActivityLabel,
  projectMessageReactions,
  showsTimeMarker,
  threadTimeMarkerLabel,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { cn } from "@rakazo/ui-web";
import { ArrowDown } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActiveBotGlyph } from "../../components/ai/CollaborationMarker";
import { useDisplayAgentSteps } from "../../lib/agent-steps-pref";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { hasRenderableBlock, isHiddenActivityBlock } from "../../lib/message-blocks";
import { messageTimeLabel } from "../../lib/message-time";
import { transcriptIsNearEnd, transcriptMovedDown } from "../../lib/transcript-scroll";
import { MessageHoverActions } from "./message-hover-actions";
import { MessageView } from "./message-view";

export const Transcript = memo(function Transcript({
  scrollRef,
  artifactTarget,
  messages,
  olderCursor,
  loadingOlder,
  answerableAskMessageId,
  running,
  workingBots,
  workingStartedAt,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onEdit,
  rewindFromSeq,
  onReact,
  onJumpToMessage,
  onOpenPeerMessages,
  memberName,
  peerBot,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  voiceReady,
  speakingMessageId,
  onSpeak,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  artifactTarget: ArtifactTarget;
  messages: ThreadMessage[];
  olderCursor: number | null;
  loadingOlder: boolean;
  answerableAskMessageId: string | null;
  running: boolean;
  workingBots: GroupAvatarMember[];
  /** Epoch ms the earliest working run started; undefined ticks from mount. */
  workingStartedAt?: number;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (message: ThreadMessage, text: string) => Promise<void>;
  onReply: (message: ThreadMessage) => void;
  onEdit: (message: ThreadMessage) => void;
  rewindFromSeq: number | null;
  onReact: (message: ThreadMessage, reaction: MessageReaction) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (
    botId: string,
  ) => { color: string; name?: string; shapeSeed?: number | null; status?: string } | undefined;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: ThreadMessage) => void;
}) {
  const { t } = useLingui();
  const showSteps = useDisplayAgentSteps();
  const [atEnd, setAtEnd] = useState(true);
  const following = useRef(true);
  const autoScrolling = useRef(false);
  const lastScrollTop = useRef<number | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  // A row arrives with a beat only when it is genuinely new activity, not
  // when a thread's history first loads and not when "Load earlier messages"
  // prepends older rows: both would otherwise read as ids this instance has
  // never seen. The line is the highest `seq` present at mount — anything
  // beyond it is new; anything at or below it is history, however it got here.
  const initialMaxSeq = useRef<number | null>(null);
  if (initialMaxSeq.current === null) {
    initialMaxSeq.current = messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0);
  }
  const isNewArrival = useCallback(
    (message: ThreadMessage) => (message.seq ?? 0) > (initialMaxSeq.current ?? 0),
    [],
  );
  // Markers read the rendered rows: a hidden activity row must not swallow a
  // marker or invent a gap.
  const reactionView = useMemo(
    () =>
      projectMessageReactions(
        messages.filter((message) =>
          message.blocks.some((block) => !isHiddenActivityBlock(block, showSteps)),
        ),
      ),
    [messages, showSteps],
  );
  const groupContinuations = useMemo(
    () =>
      computeGroupContinuations(reactionView.visibleMessages, {
        // A message stays transparent to grouping when it renders no row of its
        // own: an aside, or a message this version draws nothing for (a legacy
        // `connect`/`reasoning` block). Either one must not break a group.
        isTransparent: (m) =>
          isAsideOnlyMessage(m.blocks.filter((b) => !isHiddenActivityBlock(b, showSteps))) ||
          !hasRenderableBlock(m.blocks, showSteps),
      }),
    [reactionView.visibleMessages, showSteps],
  );
  const workingBotName = workingBots.length === 1 ? workingBots[0]?.name : undefined;
  const workingFallback = `${
    workingBotName != null && workingBotName !== ""
      ? t`${workingBotName} is working`
      : t`Bots are working`
  }…`;
  // One bot only: an activity line names one bot's tool, so it would mislabel a group.
  const workingLabel =
    (workingBots.length === 1 ? latestActivityLabel(messages) : undefined) ?? workingFallback;
  const snapToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    following.current = true;
    autoScrolling.current = false;
    setAtEnd(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
  }, [scrollRef]);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    following.current = true;
    autoScrolling.current = !reducedMotion;
    setAtEnd(true);
    element.scrollTo({
      top: element.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
    window.clearTimeout(autoScrollTimer.current);
    // Fallback only: onScroll clears autoScrolling once near-end is reached.
    autoScrollTimer.current = window.setTimeout(
      () => {
        autoScrolling.current = false;
      },
      reducedMotion ? 0 : 2_000,
    );
  }, [scrollRef]);

  useLayoutEffect(() => {
    if (following.current) snapToEnd();
  }, [messages, running, snapToEnd]);

  useLayoutEffect(() => {
    const button = jumpButtonRef.current;
    if (atEnd && button && document.activeElement === button) {
      button.blur();
    }
  }, [atEnd]);

  const loadOlder = useCallback(() => {
    const wasFollowing = following.current;
    // Prepend must not race the messages-driven snap-to-end follow path.
    following.current = false;
    autoScrolling.current = false;
    const pending = onLoadOlder();
    if (!pending) return;
    return Promise.resolve(pending).catch((error) => {
      const element = scrollRef.current;
      if (wasFollowing && element && transcriptIsNearEnd(element)) {
        following.current = true;
        setAtEnd(true);
      }
      throw error;
    });
  }, [onLoadOlder, scrollRef]);

  useEffect(
    () => () => {
      window.clearTimeout(autoScrollTimer.current);
    },
    [],
  );

  // Touch has no hover to reveal a message's action pill, so a tap toggles it.
  // This fires only for a touch pointer; desktop keeps the CSS hover path.
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const tapStart = useRef<{ x: number; y: number } | null>(null);
  const markTapStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    tapStart.current =
      event.pointerType === "touch" ? { x: event.clientX, y: event.clientY } : null;
  }, []);
  const revealOnTap = useCallback((event: ReactPointerEvent<HTMLDivElement>, messageId: string) => {
    if (event.pointerType !== "touch") return;
    // A drag (a scroll gesture also ends in a pointerup on the row) is not a tap.
    const start = tapStart.current;
    tapStart.current = null;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
    const target = event.target as HTMLElement | null;
    // A tap on a link, a control, the pill or the field belongs to that element.
    if (
      target?.closest(
        'a,button,[role="button"],[role="menuitem"],input,textarea,[contenteditable="true"],[data-slot="hover-pill"]',
      )
    )
      return;
    // A tap that selected text is a selection, not a reveal.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    setActiveMessageId((current) => (current === messageId ? null : messageId));
  }, []);
  // Dismiss the revealed pill on a tap outside its row, or on any scroll.
  useEffect(() => {
    if (activeMessageId === null) return;
    const dismissOutside = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(`[data-message-id="${CSS.escape(activeMessageId)}"]`)) return;
      setActiveMessageId(null);
    };
    const dismiss = () => setActiveMessageId(null);
    document.addEventListener("pointerdown", dismissOutside, true);
    const scroller = scrollRef.current;
    scroller?.addEventListener("scroll", dismiss, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      scroller?.removeEventListener("scroll", dismiss);
    };
  }, [activeMessageId, scrollRef]);

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="transcript"
        onPointerDown={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onTouchStart={(event) => {
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onWheel={(event) => {
          if (event.deltaY < 0) {
            lastScrollTop.current = event.currentTarget.scrollTop;
            autoScrolling.current = false;
            following.current = false;
          }
        }}
        onScroll={(event) => {
          const scrolledDown = transcriptMovedDown(
            lastScrollTop.current,
            event.currentTarget.scrollTop,
          );
          lastScrollTop.current = event.currentTarget.scrollTop;
          const nearEnd = transcriptIsNearEnd(event.currentTarget);
          setAtEnd(nearEnd);
          if (nearEnd) {
            if (scrolledDown) following.current = true;
            if (autoScrolling.current) {
              autoScrolling.current = false;
              window.clearTimeout(autoScrollTimer.current);
            }
          } else if (!autoScrolling.current) {
            following.current = false;
          }
        }}
        // px-3 / pb-8 keep a card's soft drop shadow (shadow-card reaches ~14px sideways and
        // ~26px down) from being clipped by this scroll container's overflow or hidden under
        // the rk-scroll scrollbar on the right.
        className="rk-scroll flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-3 pt-5 pb-8 md:pt-6"
      >
        {olderCursor != null ? (
          <button
            type="button"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
            className="self-center rounded-row px-3 py-1.5 text-meta text-muted-foreground hover:bg-muted hover:text-foreground/75 disabled:opacity-50"
          >
            {loadingOlder ? t`Loading…` : t`Load earlier messages`}
          </button>
        ) : null}
        {reactionView.visibleMessages.map((message, index) => {
          const chromeBlocks = message.blocks.filter(
            (block) => !isHiddenActivityBlock(block, showSteps),
          );
          // An aside is a note between messages: it gets no row chrome — no hover
          // actions, no clock, no reactions, no width cap. A bot's question or
          // approval is a normal row now — its FramedBlock card is just the row's
          // body. Aside is decided by the blocks alone (a peer receipt is stored
          // with role "user" but is still an aside).
          const chrome: "row" | "aside" = isAsideOnlyMessage(chromeBlocks) ? "aside" : "row";
          const rewound = rewindFromSeq !== null && (message.seq ?? 0) >= rewindFromSeq;
          const messageReactions = reactionView.reactions.get(message.id);
          const timeMarker = showsTimeMarker(
            reactionView.visibleMessages[index - 1]?.createdAt,
            message.createdAt,
          )
            ? threadTimeMarkerLabel(message.createdAt, {
                locale: i18n.locale || "en",
                today: t`Today`,
                yesterday: t`Yesterday`,
              })
            : "";
          const continued = groupContinuations[index] === true;
          const prev = reactionView.visibleMessages[index - 1];
          const tightenedUser = message.role === "user" && prev?.role === "user" && !timeMarker;
          return (
            <Fragment key={message.id}>
              {timeMarker ? (
                <time
                  dateTime={message.createdAt}
                  className="self-center text-label tabular-nums text-muted-foreground"
                >
                  {timeMarker}
                </time>
              ) : null}
              <div
                data-message-id={message.id}
                data-rewound={rewound ? "true" : undefined}
                data-active={
                  chrome === "row" && activeMessageId === message.id ? "true" : undefined
                }
                onPointerDown={chrome === "row" ? markTapStart : undefined}
                onPointerUp={
                  chrome === "row" ? (event) => revealOnTap(event, message.id) : undefined
                }
                className={`${
                  chrome === "row" ? "group group/message relative hover:z-20" : "relative py-0.5"
                }${chrome === "row" && activeMessageId === message.id ? " z-20" : ""}${
                  rewound ? " opacity-40" : ""
                }${isNewArrival(message) ? " animate-arrive" : ""}${
                  continued || tightenedUser ? " -mt-5" : ""
                }`}
              >
                {/* A bot row carries its time beside the author; only the user
                    bubble needs one on hover. */}
                {chrome === "row" && message.role === "user" ? (
                  <time
                    dateTime={message.createdAt}
                    data-testid="message-hover-time"
                    className="pointer-events-none absolute top-1 start-0 z-10 text-time tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 group-has-[[aria-expanded=true]]/message:opacity-100"
                  >
                    {messageTimeLabel(message.createdAt, i18n.locale)}
                  </time>
                ) : null}
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
                          `relative min-w-0 w-full ${
                            message.role === "user" ? "flex flex-col items-end" : ""
                          }`
                        : undefined
                    }
                  >
                    {chrome === "row" ? (
                      <MessageHoverActions
                        message={message}
                        revealed={activeMessageId === message.id}
                        side={message.role === "user" ? "start" : "end"}
                        onReply={onReply}
                        onEdit={onEdit}
                        onReact={onReact}
                        voiceReady={voiceReady}
                        speaking={speakingMessageId === message.id}
                        onSpeak={() => onSpeak(message)}
                      />
                    ) : null}
                    <MessageView
                      artifactTarget={artifactTarget}
                      chrome={chrome}
                      message={message}
                      continued={continued}
                      canAnswer={message.id === answerableAskMessageId}
                      onOpenBot={onOpenBot}
                      onOpenPeerMessages={onOpenPeerMessages}
                      onAnswer={onAnswer}
                      speakerName={
                        chrome !== "row" || message.role !== "bot"
                          ? undefined
                          : memberName?.(message.botId)
                      }
                      memberName={memberName}
                      peerBot={peerBot}
                      replyPreview={
                        message.replyToMessageId
                          ? messageById.get(message.replyToMessageId)
                          : undefined
                      }
                      replyToMessageId={message.replyToMessageId}
                      onJumpToMessage={onJumpToMessage}
                      onRefresh={onRefresh}
                      onBotChanged={onBotChanged}
                      onAddRoutine={onAddRoutine}
                    />
                  </div>
                </div>
                {chrome === "row" && messageReactions ? (
                  <div
                    data-testid="message-reactions"
                    className={cn(
                      "mt-1 flex flex-wrap gap-1",
                      message.role === "user" && "justify-end",
                    )}
                  >
                    {[...messageReactions].map(([emoji, count]) => (
                      <span
                        key={emoji}
                        className="rounded-full border border-border bg-muted px-2 py-0.5 text-time"
                      >
                        {emoji}
                        {count > 1 ? ` ${count}` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </Fragment>
          );
        })}
        {running &&
        !messages.some(
          (message) =>
            message.id.startsWith("progress:") &&
            message.blocks.some(
              (block) =>
                block.kind === "progress" && !isToolActivityBlock(block) && Boolean(block.text),
            ),
        ) ? (
          <ActiveBotGlyph bots={workingBots} label={workingLabel} startedAt={workingStartedAt} />
        ) : null}
      </div>
      <button
        ref={jumpButtonRef}
        type="button"
        aria-label={t`Jump to latest`}
        aria-hidden={atEnd}
        tabIndex={atEnd ? -1 : 0}
        onClick={jumpToLatest}
        className={`absolute bottom-4 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-border bg-muted/95 text-foreground/75 shadow-floating backdrop-blur transition-[opacity,transform,background-color] duration-(--duration-hover) ease-quiet hover:bg-border motion-reduce:transition-none ${
          atEnd ? "pointer-events-none translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        }`}
      >
        <ArrowDown size={17} strokeWidth={1.8} />
      </button>
    </div>
  );
});
