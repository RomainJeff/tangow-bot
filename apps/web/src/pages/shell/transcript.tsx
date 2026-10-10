import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadMessage } from "@rakazo/contracts";
import type { SkillSourceBlock } from "@rakazo/core";
import {
  computeMessageGroups,
  foldRoutineRuns,
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
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
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
import type { SpawnBotCardEdits } from "../../components/AskCard";
import { ActiveBotGlyph } from "../../components/ai/CollaborationMarker";
import { useDisplayAgentSteps } from "../../lib/agent-steps-pref";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { hasRenderableBlock, isHiddenActivityBlock } from "../../lib/message-blocks";
import { messageTimeLabel } from "../../lib/message-time";
import {
  initialMaxSeq,
  isNewArrivalSeq,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "../../lib/transcript-scroll";
import { placeHoverPill } from "./hover-pill-placement";
import { MessageActionsSheet } from "./message-actions-sheet";
import { MessageHoverActions, UserMessageActions } from "./message-hover-actions";
import { MessageView } from "./message-view";

/** B1: hold this long on a touch bubble to open its action sheet. */
const LONG_PRESS_MS = 450;
/** The bubble settles (scale 0.96) this far into the hold, before the sheet opens. */
const LONG_PRESS_SQUASH_MS = 150;
/** More than this many px of movement during the hold cancels it — a scroll, not a press. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
/** A long press starts on the bubble itself, not its controls (a link still starts one — B3). */
const LONG_PRESS_BUBBLE_SELECTOR = '[data-slot="message-row-bubble"],[data-slot="user-bubble"]';
const LONG_PRESS_EXCLUDED_SELECTOR =
  'button,[role="button"],[role="menuitem"],input,textarea,[contenteditable="true"],select';

export const Transcript = memo(function Transcript({
  scrollRef,
  artifactTarget,
  inGroup,
  messages,
  olderCursor,
  loadingOlder,
  answerableAskMessageId,
  viewerUserId,
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
  onOpenSkill,
  voiceReady,
  speakingMessageId,
  onSpeak,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  artifactTarget: ArtifactTarget;
  /** True in a multi-bot (group) thread: messages group by author with a
   * shared name/avatar. False in a single-bot (mono) thread: no message ever
   * shows a name or avatar — the bot's identity lives in the header. */
  inGroup: boolean;
  messages: ThreadMessage[];
  olderCursor: number | null;
  loadingOlder: boolean;
  answerableAskMessageId: string | null;
  viewerUserId?: string;
  running: boolean;
  workingBots: GroupAvatarMember[];
  /** Epoch ms the earliest working run started; undefined ticks from mount. */
  workingStartedAt?: number;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string) => void;
  onAnswer: (message: ThreadMessage, text: string, edits?: SpawnBotCardEdits) => Promise<void>;
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
  /** Opens a skill in its bot's page, from the line under the message that touched it. */
  onOpenSkill?: (skill: SkillSourceBlock) => void;
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
  const maxSeqAtMount = useRef<number | null>(null);
  if (maxSeqAtMount.current === null) {
    maxSeqAtMount.current = initialMaxSeq(messages);
  }
  const isNewArrival = useCallback(
    (message: ThreadMessage) => isNewArrivalSeq(message.seq, maxSeqAtMount.current ?? 0),
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
  // Rule R (packages/core/src/message-grouping.ts, docs/design-system.md §
  // Grouping): an aside no longer stays transparent to grouping — it breaks
  // the group and the next message reopens it. Only a message this version
  // draws nothing for (a legacy `connect`/`reasoning` block) stays
  // transparent, so it can never break a group either side of it.
  const messageGroups = useMemo(
    () =>
      computeMessageGroups(reactionView.visibleMessages, {
        isTransparent: (m) => !hasRenderableBlock(m.blocks, showSteps),
      }),
    [reactionView.visibleMessages, showSteps],
  );
  // Routine runs as log lines: a run keeps the message it then sent, and a
  // bot's consecutive quiet runs with nothing between them share one line. A
  // folded run or an absorbed handoff renders nothing (its role is "hidden").
  const routineRoles = useMemo(
    () => foldRoutineRuns(reactionView.visibleMessages),
    [reactionView.visibleMessages],
  );
  const isRoutineRow = useCallback(
    (message: ThreadMessage | undefined) => {
      if (!message) return false;
      const role = routineRoles.get(message.id);
      return role?.kind === "run" || role?.kind === "group";
    },
    [routineRoles],
  );
  // Time markers down the rendered (non-hidden) rows: between two routine
  // lines a marker only says the day, when it changes (routine lines carry
  // their own time already) — everywhere else, the usual day-and-time label.
  // `previousVisibleRow` is the row rendered just before each one (skipping
  // anything hidden), used both for that and for the zero gap between two
  // consecutive routine lines.
  const { timeMarkers, previousVisibleRow } = useMemo(() => {
    const markers = new Map<string, string>();
    const before = new Map<string, ThreadMessage>();
    let previousRow: ThreadMessage | undefined;
    let previous: { createdAt?: string; routine: boolean } | undefined;
    for (const message of reactionView.visibleMessages) {
      const role = routineRoles.get(message.id);
      if (role?.kind === "hidden") continue;
      const routine = role?.kind === "run" || role?.kind === "group";
      // A group line stands for a fold of earlier runs: its marker is about
      // when that stretch started (the fold's first run), not this message's
      // own timestamp (its last, folded run).
      const at = role?.kind === "group" ? role.runs[0]?.createdAt : message.createdAt;
      if (at) {
        const shows =
          routine && previous?.routine
            ? new Date(previous.createdAt ?? at).toDateString() !== new Date(at).toDateString()
            : showsTimeMarker(previous?.createdAt, at);
        if (shows) {
          markers.set(
            message.id,
            threadTimeMarkerLabel(at, {
              locale: i18n.locale || "en",
              today: t`Today`,
              yesterday: t`Yesterday`,
              withTime: !routine,
            }),
          );
        }
      }
      // The next row is measured from the group's last run, like on mobile.
      previous = { createdAt: message.createdAt ?? previous?.createdAt, routine };
      if (previousRow) before.set(message.id, previousRow);
      previousRow = message;
    }
    return { timeMarkers: markers, previousVisibleRow: before };
  }, [reactionView.visibleMessages, routineRoles, t]);
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

  // B1-B4: a touch long press on a message bubble opens its action sheet —
  // the pill itself never appears on touch (no hover to reveal it with;
  // mouse and keyboard keep the existing hover/focus pill, untouched below).
  const [pressingMessageId, setPressingMessageId] = useState<string | null>(null);
  const [sheetMessage, setSheetMessage] = useState<ThreadMessage | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pressStart = useRef<{ id: string; pointerId: number; x: number; y: number } | null>(null);
  const squashTimer = useRef<number | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  // Set once the hold opens the sheet, so the click the browser still fires
  // once the finger lifts (even over a link) is swallowed instead of acting.
  const suppressClickForId = useRef<string | null>(null);

  const clearPressTimers = useCallback(() => {
    window.clearTimeout(squashTimer.current);
    window.clearTimeout(openTimer.current);
    squashTimer.current = undefined;
    openTimer.current = undefined;
  }, []);

  const cancelPress = useCallback(() => {
    clearPressTimers();
    pressStart.current = null;
    setPressingMessageId(null);
  }, [clearPressTimers]);

  const onBubblePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, message: ThreadMessage) => {
      // A second finger never starts, resets or cancels the first one's press.
      if (pressStart.current && pressStart.current.pointerId !== event.pointerId) {
        cancelPress();
        return;
      }
      // Each new touch starts fresh: a suppression left over from a previous
      // long press must never swallow an unrelated, later, genuine tap.
      suppressClickForId.current = null;
      if (event.pointerType !== "touch") return;
      // A message still being written has no actions yet (as on hover).
      if (message.id.startsWith("progress:")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(LONG_PRESS_EXCLUDED_SELECTOR)) return;
      if (!target?.closest(LONG_PRESS_BUBBLE_SELECTOR)) return;
      clearPressTimers();
      pressStart.current = {
        id: message.id,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      squashTimer.current = window.setTimeout(() => {
        setPressingMessageId(message.id);
      }, LONG_PRESS_SQUASH_MS);
      openTimer.current = window.setTimeout(() => {
        pressStart.current = null;
        setPressingMessageId(null);
        suppressClickForId.current = message.id;
        setSheetMessage(message);
        setSheetOpen(true);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    },
    [clearPressTimers, cancelPress],
  );

  const onBubblePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (pressStart.current && pressStart.current.pointerId !== event.pointerId) return;
      cancelPress();
    },
    [cancelPress],
  );

  const onBubblePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = pressStart.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        cancelPress();
      }
    },
    [cancelPress],
  );

  // A link's click follows the pointerup that ended the long press that
  // opened the sheet for it (B3): swallow that one click so it never navigates.
  const onRowClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, messageId: string) => {
      if (suppressClickForId.current !== messageId) return;
      suppressClickForId.current = null;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  useEffect(() => cancelPress, [cancelPress]);
  // A real scroll gesture, wherever it starts, is never a long press.
  useEffect(() => {
    const scroller = scrollRef.current;
    scroller?.addEventListener("scroll", cancelPress, { passive: true });
    return () => scroller?.removeEventListener("scroll", cancelPress);
  }, [cancelPress, scrollRef]);
  // Keyboard focus reveals a row's pill too, so it is placed on focus as on hover.
  useEffect(() => {
    const scroller = scrollRef.current;
    const place = (event: FocusEvent) => {
      const row = (event.target as Element | null)?.closest<HTMLElement>("[data-message-id]");
      if (row) placeHoverPill(row);
    };
    scroller?.addEventListener("focusin", place);
    return () => scroller?.removeEventListener("focusin", place);
  }, [scrollRef]);

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
        className="rk-scroll flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3 pt-5 pb-8 md:pt-6"
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
          // Drawn by another line: a folded routine run, or the handoff a run
          // sent, absorbed into that run's own line. Renders nothing.
          const routineRole = routineRoles.get(message.id);
          if (routineRole?.kind === "hidden") return null;
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
          const timeMarker = timeMarkers.get(message.id) ?? "";
          const group = messageGroups[index]!;
          const prevMessage = reactionView.visibleMessages[index - 1];
          const prevChrome: "row" | "aside" | undefined = prevMessage
            ? isAsideOnlyMessage(
                prevMessage.blocks.filter((b) => !isHiddenActivityBlock(b, showSteps)),
              )
              ? "aside"
              : "row"
            : undefined;
          // 14px between groups (the container's own `gap-3.5`) narrows to 3px
          // within a group, to 0 between two consecutive asides, and to 0
          // between two consecutive routine lines (they stack like a log) —
          // unless a day marker sits between them, which keeps its own air.
          const routineChain =
            !timeMarker &&
            isRoutineRow(message) &&
            isRoutineRow(previousVisibleRow.get(message.id));
          const spacingClass = routineChain
            ? " -mt-3.5"
            : !group.isFirstOfGroup
              ? " -mt-2.75"
              : chrome === "aside" && prevChrome === "aside"
                ? " -mt-3.5"
                : "";
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
                data-long-pressing={
                  chrome === "row" && pressingMessageId === message.id ? "true" : undefined
                }
                onPointerEnter={
                  chrome === "row" ? (event) => placeHoverPill(event.currentTarget) : undefined
                }
                onPointerDown={
                  chrome === "row" ? (event) => onBubblePointerDown(event, message) : undefined
                }
                onPointerMove={chrome === "row" ? onBubblePointerMove : undefined}
                onPointerUp={chrome === "row" ? onBubblePointerEnd : undefined}
                onPointerCancel={chrome === "row" ? onBubblePointerEnd : undefined}
                onClickCapture={
                  chrome === "row" ? (event) => onRowClickCapture(event, message.id) : undefined
                }
                className={`${
                  chrome === "row" ? "group group/message relative hover:z-20" : "relative py-0.5"
                }${rewound ? " opacity-40" : ""}${
                  isNewArrival(message) ? " animate-arrive" : ""
                }${spacingClass}`}
              >
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
                        ? // The pill floats in this frame: beside the bubble when there is
                          // room (`placeHoverPill`), else at its top-end corner, so both
                          // rows run the full column width. A user row right-aligns its
                          // bubble with `items-end` and caps it at 78% (`UserBubble`); the old
                          // `w-fit` collapsed to the left once the bubble reached that 78% cap,
                          // because fit-content resolves a percentage-capped child to full width.
                          `relative min-w-0 w-full ${
                            message.role === "user" ? "flex flex-col items-end" : ""
                          }`
                        : undefined
                    }
                  >
                    {/* The pill is for a bot's message: your own gets Edit and Copy
                        under it (below), and a routine line opens on a tap. */}
                    {chrome === "row" && message.role !== "user" && !isRoutineRow(message) ? (
                      <MessageHoverActions
                        message={message}
                        // No row carries a permanent clock: the time rides in the pill, next
                        // to the bubble or card. Cards have no clock of their own.
                        time={
                          <time dateTime={message.createdAt} data-testid="message-hover-time">
                            {messageTimeLabel(message.createdAt, i18n.locale)}
                          </time>
                        }
                        onReply={onReply}
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
                      inGroup={inGroup}
                      showAuthor={inGroup && group.isFirstOfGroup}
                      showAvatar={inGroup && group.isLastOfGroup}
                      canAnswer={message.id === answerableAskMessageId}
                      viewerUserId={viewerUserId}
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
                      routineRole={routineRole}
                      onOpenSkill={onOpenSkill}
                      arrivesLive={isNewArrival(message)}
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
                {chrome === "row" && message.role === "user" ? (
                  <UserMessageActions message={message} onEdit={onEdit} />
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
      <MessageActionsSheet
        message={sheetMessage}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onReply={onReply}
        onEdit={onEdit}
        onReact={onReact}
        voiceReady={voiceReady}
        speaking={sheetMessage !== null && speakingMessageId === sheetMessage.id}
        onSpeak={onSpeak}
      />
    </div>
  );
});
