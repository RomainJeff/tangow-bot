import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type { MessageReaction, ThreadItem } from "@rakazo/contracts";
import type { SkillSourceBlock, ThreadView } from "@rakazo/core";
import { isToolActivityBlock, latestActivityLabel } from "@rakazo/core";
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
import { messageTimeLabel } from "../../lib/message-time";
import type { CardAnswerTarget, MessageItem, SessionViewTarget } from "../../lib/thread-items";
import { isLiveItem } from "../../lib/thread-items";
import {
  arrivedAfterMount,
  transcriptEnd,
  transcriptIsNearEnd,
  transcriptMovedDown,
} from "../../lib/transcript-scroll";
import { placeHoverPill } from "./hover-pill-placement";
import { MessageActionsSheet } from "./message-actions-sheet";
import { MessageHoverActions, UserMessageActions } from "./message-hover-actions";
import { SessionView } from "./session-view";
import type { RowContext } from "./thread-row";
import { RowMarker, rowChrome, ThreadRowBody } from "./thread-row";

/** B1: hold this long on a touch bubble to open its action sheet. */
/** How long a jump to a message holds off following the end while its smooth scroll gets going. */
const JUMP_SETTLE_MS = 1500;
const LONG_PRESS_MS = 450;
/** The bubble settles (scale 0.96) this far into the hold, before the sheet opens. */
const LONG_PRESS_SQUASH_MS = 150;
/** More than this many px of movement during the hold cancels it — a scroll, not a press. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
/** A long press starts on the bubble itself, not its controls (a link still starts one — B3). */
const LONG_PRESS_BUBBLE_SELECTOR = '[data-slot="message-row-bubble"],[data-slot="user-bubble"]';
const LONG_PRESS_EXCLUDED_SELECTOR =
  'button,[role="button"],[role="menuitem"],input,textarea,[contenteditable="true"],select';

/** An approval card takes the actions of the bot message it was on main, keyed by its own entry. */
function actionTarget(item: ThreadItem): MessageItem | null {
  if (item.kind === "message") return item;
  if (item.kind !== "effect" || !item.card || !item.botId) return null;
  return {
    kind: "message",
    role: "bot",
    id: item.id,
    ts: item.ts,
    botId: item.botId,
    ...(item.runId ? { runId: item.runId } : {}),
    blocks: [item.card],
  };
}

export const Transcript = memo(function Transcript({
  scrollRef,
  followingRef,
  artifactTarget,
  inGroup,
  view,
  olderCursor,
  loadingOlder,
  viewerUserId,
  running,
  workingBots,
  workingStartedAt,
  onLoadOlder,
  onOpenBot,
  onAnswer,
  onReply,
  onEdit,
  rewindFromItemId,
  onReact,
  onRemember,
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
  /** Whether the view follows the end; Shell reads it before snapping after a refresh. */
  followingRef: RefObject<boolean>;
  artifactTarget: ArtifactTarget;
  /** True in a multi-bot (group) thread: messages group by author with a
   * shared name/avatar. False in a single-bot (mono) thread: no message ever
   * shows a name or avatar — the bot's identity lives in the header. */
  inGroup: boolean;
  view: ThreadView;
  olderCursor: string | null;
  loadingOlder: boolean;
  viewerUserId?: string;
  running: boolean;
  workingBots: GroupAvatarMember[];
  /** Epoch ms the earliest working run started; undefined ticks from mount. */
  workingStartedAt?: number;
  onLoadOlder: () => void | Promise<void>;
  onOpenBot: (botId: string, messageId?: string) => void;
  onAnswer: (target: CardAnswerTarget, text: string, edits?: SpawnBotCardEdits) => Promise<void>;
  onReply: (message: MessageItem) => void;
  onEdit: (message: MessageItem) => void;
  rewindFromItemId: string | null;
  onReact: (message: MessageItem, reaction: MessageReaction) => Promise<void>;
  onRemember?: (message: MessageItem, botId: string | undefined) => Promise<void>;
  onJumpToMessage: (messageId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: RowContext["peerBot"];
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  onOpenSkill?: (skill: SkillSourceBlock) => void;
  voiceReady: boolean;
  speakingMessageId: string | null;
  onSpeak: (message: MessageItem) => void;
}) {
  const { t } = useLingui();
  const showSteps = useDisplayAgentSteps();
  const [atEnd, setAtEnd] = useState(true);
  const following = followingRef;
  const mounted = useRef(false);
  if (!mounted.current) {
    mounted.current = true;
    following.current = true;
  }
  const autoScrolling = useRef(false);
  const jumpedAt = useRef(Number.NEGATIVE_INFINITY);
  const jumpSettleTimer = useRef<number | undefined>(undefined);
  const lastScrollTop = useRef<number | null>(null);
  const press = useRef<{ top: number; following: boolean } | null>(null);
  const autoScrollTimer = useRef<number | undefined>(undefined);
  const jumpButtonRef = useRef<HTMLButtonElement>(null);
  const [sessionTarget, setSessionTarget] = useState<SessionViewTarget | null>(null);
  const { rows, waiting, rowOf } = view;
  const messages = useMemo(
    () => rows.flatMap((row) => (row.item.kind === "message" ? [row.item] : [])),
    [rows],
  );
  const idsAtMount = useRef<ReadonlySet<string> | null>(null);
  if (idsAtMount.current === null) {
    idsAtMount.current = new Set(rows.map((row) => row.item.id));
  }
  const arrived = useMemo(
    () =>
      arrivedAfterMount(
        idsAtMount.current ?? new Set(),
        rows.map((row) => row.item.id),
      ),
    [rows],
  );
  const rewindFromIndex =
    rewindFromItemId === null ? -1 : rows.findIndex((row) => row.item.id === rewindFromItemId);
  const context = useMemo<RowContext>(() => {
    const messageById = new Map(messages.map((message) => [message.id as string, message]));
    return {
      artifactTarget,
      inGroup,
      viewerUserId,
      waiting,
      onAnswer,
      memberName,
      peerBot,
      onOpenBot,
      onOpenPeerMessages,
      onOpenSession: setSessionTarget,
      // A jump the person asked for leaves the end, so the next streamed row must not pull back.
      onJumpToMessage: (messageId) => {
        following.current = false;
        jumpedAt.current = performance.now();
        onJumpToMessage(messageId);
        window.clearTimeout(jumpSettleTimer.current);
        // A jump to a row already on the last screen never scrolls down: follow again once it settles there.
        jumpSettleTimer.current = window.setTimeout(() => {
          const element = scrollRef.current;
          if (!element) return;
          const nearEnd = transcriptIsNearEnd(element);
          setAtEnd(nearEnd);
          const rowId = rowOf.get(messageId) ?? messageId;
          if (nearEnd && element.querySelector(`[data-message-id="${CSS.escape(rowId)}"]`)) {
            following.current = true;
          }
        }, JUMP_SETTLE_MS);
      },
      onRefresh,
      onBotChanged,
      onAddRoutine,
      onOpenSkill,
      messageOfEntry: (entryId) => {
        const itemId = rowOf.get(entryId);
        return itemId ? messageById.get(itemId) : undefined;
      },
    };
  }, [
    artifactTarget,
    inGroup,
    viewerUserId,
    waiting,
    onAnswer,
    memberName,
    peerBot,
    onOpenBot,
    onOpenPeerMessages,
    onJumpToMessage,
    onRefresh,
    onBotChanged,
    onAddRoutine,
    onOpenSkill,
    messages,
    rowOf,
    scrollRef,
  ]);
  const remember = useMemo(
    () =>
      onRemember &&
      ((message: MessageItem) =>
        void onRemember(message, "botId" in artifactTarget ? artifactTarget.botId : undefined)),
    [onRemember, artifactTarget],
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
    element.scrollTo({ top: transcriptEnd(element), behavior: "auto" });
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
  }, [rows, running, snapToEnd]);

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
      window.clearTimeout(jumpSettleTimer.current);
    },
    [],
  );

  // B1-B4: a touch long press on a message bubble opens its action sheet —
  // the pill itself never appears on touch (no hover to reveal it with;
  // mouse and keyboard keep the existing hover/focus pill, untouched below).
  const [pressingMessageId, setPressingMessageId] = useState<string | null>(null);
  const [sheetMessage, setSheetMessage] = useState<MessageItem | null>(null);
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
    (event: ReactPointerEvent<HTMLDivElement>, message: MessageItem) => {
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
      if (isLiveItem(message)) return;
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
          press.current = { top: event.currentTarget.scrollTop, following: following.current };
          lastScrollTop.current = event.currentTarget.scrollTop;
          autoScrolling.current = false;
          following.current = false;
        }}
        onPointerUp={(event) => {
          // A press that left the list where it was is a tap on a row (a card's choice), not a
          // hand on the scroll: the view keeps following the end it followed.
          if (press.current?.following && event.currentTarget.scrollTop === press.current.top) {
            following.current = true;
          }
          press.current = null;
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
            // While a jump's smooth scroll starts, a row landing at the end must not resume following.
            if (scrolledDown && performance.now() - jumpedAt.current > JUMP_SETTLE_MS) {
              following.current = true;
            }
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
        {rows.map((row, index) => {
          const { item } = row;
          const chrome = rowChrome(item, showSteps);
          const message = actionTarget(item);
          const acts = message !== null && chrome === "row";
          const rewound = rewindFromIndex >= 0 && index >= rewindFromIndex;
          const previous = rows[index - 1];
          const prevChrome = previous ? rowChrome(previous.item, showSteps) : undefined;
          const arrives = arrived.has(item.id);
          // 14px between groups (the container's own `gap-3.5`) narrows to 3px
          // within a group, and to 0 between two consecutive asides or two
          // chained routine failure lines (they stack like a log).
          const spacingClass = row.chained
            ? " -mt-3.5"
            : !row.firstOfGroup
              ? " -mt-2.75"
              : chrome === "aside" && prevChrome === "aside"
                ? " -mt-3.5"
                : "";
          return (
            <Fragment key={item.id}>
              {row.marker ? <RowMarker marker={row.marker} /> : null}
              <div
                data-message-id={item.id}
                data-rewound={rewound ? "true" : undefined}
                data-long-pressing={acts && pressingMessageId === item.id ? "true" : undefined}
                onPointerEnter={acts ? (event) => placeHoverPill(event.currentTarget) : undefined}
                onPointerDown={
                  acts && message ? (event) => onBubblePointerDown(event, message) : undefined
                }
                onPointerMove={acts ? onBubblePointerMove : undefined}
                onPointerUp={acts ? onBubblePointerEnd : undefined}
                onPointerCancel={acts ? onBubblePointerEnd : undefined}
                onClickCapture={acts ? (event) => onRowClickCapture(event, item.id) : undefined}
                className={`${
                  acts ? "group group/message relative hover:z-20" : "relative py-0.5"
                }${rewound ? " opacity-40" : ""}${arrives ? " animate-arrive" : ""}${spacingClass}`}
              >
                <div
                  className={
                    acts
                      ? `relative flex ${message.role === "user" ? "justify-end" : "justify-start"}`
                      : undefined
                  }
                >
                  <div
                    data-testid={acts ? "message-bubble-frame" : undefined}
                    className={
                      acts
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
                    {acts && message.role !== "user" ? (
                      <MessageHoverActions
                        message={message}
                        previewMessageId={row.previewMessageId}
                        // No row carries a permanent clock: the time rides in the pill, next
                        // to the bubble or card. Cards have no clock of their own.
                        time={
                          <time dateTime={message.ts} data-testid="message-hover-time">
                            {messageTimeLabel(message.ts, i18n.locale)}
                          </time>
                        }
                        onRemember={remember}
                        onReply={onReply}
                        onReact={onReact}
                        voiceReady={voiceReady}
                        speaking={speakingMessageId === message.id}
                        onSpeak={() => onSpeak(message)}
                      />
                    ) : null}
                    <ThreadRowBody
                      row={row}
                      context={context}
                      chrome={chrome}
                      showAuthor={row.firstOfGroup}
                      showAvatar={row.lastOfGroup}
                      arrivesLive={arrives}
                    />
                  </div>
                </div>
                {acts && row.reactions.length > 0 ? (
                  <div
                    data-testid="message-reactions"
                    className={cn(
                      "mt-1 flex flex-wrap gap-1",
                      message.role === "user" && "justify-end",
                    )}
                  >
                    {row.reactions.map(([emoji, count]) => (
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
                {acts && message.role === "user" ? (
                  <UserMessageActions
                    message={message}
                    previewMessageId={row.previewMessageId}
                    onEdit={onEdit}
                    onRemember={remember}
                  />
                ) : null}
              </div>
            </Fragment>
          );
        })}
        {running &&
        !messages.some(
          (message) =>
            isLiveItem(message) &&
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
        previewMessageId={rows.find((row) => row.item.id === sheetMessage?.id)?.previewMessageId}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onReply={onReply}
        onEdit={onEdit}
        onReact={onReact}
        onRemember={remember}
        voiceReady={voiceReady}
        speaking={sheetMessage !== null && speakingMessageId === sheetMessage.id}
        onSpeak={onSpeak}
      />
      {sessionTarget ? (
        <SessionView
          key={sessionTarget.kind === "session" ? sessionTarget.sessionId : sessionTarget.runId}
          target={sessionTarget}
          context={context}
          onClose={() => setSessionTarget(null)}
        />
      ) : null}
    </div>
  );
});
