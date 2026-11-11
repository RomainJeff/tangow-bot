import type { ComputerStatus, ProductEvent } from "@rakazo/contracts";
import {
  appendedEntries,
  blocksOfBotWords,
  botWordsOf,
  isRunTerminalEvent,
  runThreadSubscription,
} from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { markOnce } from "../../lib/performance";
import { rpc } from "../../lib/rpc";
import type { ThreadState } from "../../lib/thread-events";
import {
  isComputerStatusEvent,
  isThreadStateEvent,
  reconcileRefreshedThread,
  reduceComputerStatus,
  reduceThreadState,
} from "../../lib/thread-events";
import {
  transcriptCanSnapAfterFrame,
  transcriptEnd,
  transcriptIsNearEnd,
} from "../../lib/transcript-scroll";
import type { BrowserNotifications } from "./use-browser-notifications";
import type { ComputerScreen } from "./use-computer-screen";
import type { Roster } from "./use-roster";
import type { ThreadStore } from "./use-thread-store";

const THREAD_SNAPSHOT_TIMEOUT_MS = 2_000;

function threadSnapshotSignal(parent: AbortSignal): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(THREAD_SNAPSHOT_TIMEOUT_MS)]);
}

function applyThreadEvent(
  event: ProductEvent,
  commitSnapshot: (next: ThreadState | null) => void,
  commitComputer: (next: ComputerStatus | null) => void,
  snapshotRef: RefObject<ThreadState | null>,
  computerRef: RefObject<ComputerStatus | null>,
  /** A group carries several bots' computer events: only those of its open computer's bot apply. */
  groupComputerBotId?: string | null,
) {
  if (isThreadStateEvent(event)) {
    const next = reduceThreadState(snapshotRef.current, event);
    commitSnapshot(next);
  }
  if (
    isComputerStatusEvent(event) &&
    (groupComputerBotId === undefined || event.botId === groupComputerBotId)
  ) {
    const next = reduceComputerStatus(computerRef.current, event);
    commitComputer(next);
  }
}

/**
 * Keeps the open bot or group thread current: reads it, subscribes to its
 * events, and fans each event out to the roster, notifications and computer.
 */
export function useThreadSync({
  roster,
  store,
  screen,
  searchParams,
  notifyBrowserForEvent,
  refreshRoutines,
}: {
  roster: Roster;
  store: ThreadStore;
  screen: ComputerScreen;
  searchParams: URLSearchParams;
  notifyBrowserForEvent: BrowserNotifications["notifyBrowserForEvent"];
  refreshRoutines: (botId: string) => Promise<void>;
}) {
  const { active, activeGroup, groupId, activeBotId, activeGroupId, botsRef } = roster;
  const { manuallyUnread, setGroups, markBotReadIfVisible, refreshBots } = roster;
  const { snapshotRef, computerRef, commitSnapshot, commitComputer, cacheComputerFor } = store;
  const { expandedHistoryThread, historyEpoch, messageScroll, followingEnd } = store;
  const { refreshComputerScreen, refreshComputerStatus, botIdRef: computerBotId } = screen;
  // Mirrors searchParams for effects that only need to read it once on run,
  // not re-run on every unrelated query-param change (e.g. the SSE subscribe
  // effect below, which should only restart when the active bot changes).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const threadRefreshEpoch = useRef(0);
  const groupRefreshEpoch = useRef(0);
  const readVisibleGroups = useRef(new Set<string>());
  const [activityEpoch, setActivityEpoch] = useState(0);

  function snapTranscriptToEndAfterFrame() {
    const queuedElement = messageScroll.current;
    if (!queuedElement) return;
    const queuedScrollTop = queuedElement.scrollTop;
    window.requestAnimationFrame(() => {
      const element = messageScroll.current;
      if (transcriptCanSnapAfterFrame(element, queuedElement, queuedScrollTop)) {
        queuedElement.scrollTop = transcriptEnd(queuedElement);
      }
    });
  }

  async function refreshGroupThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const request = ++groupRefreshEpoch.current;
    const snap = await rpc.threads.get({ groupId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (activeGroupId.current !== id || request !== groupRefreshEpoch.current) return snap;
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    // The computer of the bot whose run waits for you here stays; any other is not this thread's.
    if (!computerBotId.current || computerRef.current?.botId !== computerBotId.current) {
      commitComputer(null);
    }
    store.setRoutines([]);
    store.setRoutinesBotId(null);
    // Keep the search-jump viewport; expandedHistoryThread merge still accepts live messages.
    // A jump the person made, even while this read was in flight, ends following the end.
    if (
      stickToEnd &&
      followingEnd.current &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    return snap;
  }

  async function refreshThread(id: string, signal?: AbortSignal) {
    const scrollElement = messageScroll.current;
    const stickToEnd = !scrollElement || transcriptIsNearEnd(scrollElement);
    markOnce("rk:renderer:thread-request-start");
    const epoch = historyEpoch.current;
    const request = ++threadRefreshEpoch.current;
    // Apply threads.get as soon as it returns so stop/takeover status is not held behind
    // routines/skills/screen fetches (progress can advance the cursor meanwhile).
    const snap = await rpc.threads.get({ botId: id }, signal ? { signal } : undefined);
    markOnce("rk:renderer:thread-response");
    if (
      activeBotId.current !== id ||
      epoch !== historyEpoch.current ||
      request !== threadRefreshEpoch.current
    ) {
      return snap;
    }
    const reconciled = reconcileRefreshedThread(
      snapshotRef.current,
      snap,
      computerRef.current,
      expandedHistoryThread.current === snap.threadId,
    );
    commitSnapshot(reconciled.snapshot);
    commitComputer(reconciled.computer);
    cacheComputerFor(id, { computer: reconciled.computer });
    // A jump the person made, even while this read was in flight, ends following the end.
    if (
      stickToEnd &&
      followingEnd.current &&
      (!scrollElement || transcriptIsNearEnd(scrollElement)) &&
      expandedHistoryThread.current !== snap.threadId
    ) {
      snapTranscriptToEndAfterFrame();
    }
    void refreshRoutines(id).catch(() => undefined);
    void Promise.all([
      rpc.skills.list({ botId: id }).catch(() => null),
      refreshComputerScreen(id).catch(() => null),
    ]).then(([skills]) => {
      if (
        activeBotId.current !== id ||
        epoch !== historyEpoch.current ||
        request !== threadRefreshEpoch.current
      ) {
        return;
      }
      if (skills) {
        store.setTaughtSkills(skills);
        store.setTaughtSkillsBotId(id);
      }
    });
    return snap;
  }

  useEffect(() => {
    if (!active) return;
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) {
      store.pinnedAroundRef.current = null;
    }
    screen.showCachedComputer(active.id);
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: async () => {
        const primed = store.bootstrappedThread.current;
        store.bootstrappedThread.current = null;
        // Pending search jumps load the around-page separately; avoid replacing it with latest.
        return primed?.botId === active.id
          ? primed
          : pendingJump
            ? rpc.threads.get({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) })
            : refreshThread(active.id, threadSnapshotSignal(abort.signal));
      },
      loadHead: () =>
        rpc.threads.head({ botId: active.id }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshThread(active.id, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor) =>
        rpc.threads.subscribe({ botId: active.id, cursor }, { signal: abort.signal }),
      beforeEvent: (event) => {
        const terminalRunReceipts = store.terminalRunReceipts;
        if (isRunTerminalEvent(event) && event.runId) {
          terminalRunReceipts.current.add(event.runId);
          if (terminalRunReceipts.current.size > 100) {
            const oldest = terminalRunReceipts.current.values().next().value;
            if (oldest !== undefined) terminalRunReceipts.current.delete(oldest);
          }
        }
      },
      applyEvent: (event) =>
        applyThreadEvent(event, commitSnapshot, commitComputer, snapshotRef, computerRef),
      onEvent: (event, initial) => {
        const currentBot = botsRef.current.find((bot) => bot.id === active.id);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          currentBot?.name ?? active.name,
          currentBot?.notifyOnFinish ?? false,
          false,
        );
        const appended = appendedEntries(event);
        const cut = appended.some((entry) => entry.type === "clear" || entry.type === "rewind");
        if (appended.some((entry) => entry.type === "clear")) {
          store.leaveJumpWindow();
          historyEpoch.current += 1;
        }
        if (isRunTerminalEvent(event)) setActivityEpoch((epoch) => epoch + 1);
        if (event.type === "bot.archived") {
          void refreshBots(true).catch(() => undefined);
        } else if (
          event.type === "bot.spawned" ||
          event.type === "bot.deleted" ||
          event.type === "run.started" ||
          isRunTerminalEvent(event) ||
          cut
        ) {
          void refreshBots().catch(() => undefined);
        }
        const words = botWordsOf(event);
        if (words.length > 0) {
          if (
            words.some((entry) =>
              blocksOfBotWords(entry).some((block) => block.kind === "child_bot"),
            )
          ) {
            void refreshBots().catch(() => undefined);
          }
          markBotReadIfVisible(active.id);
        }
        if (isRunTerminalEvent(event) || event.type === "skill.teaching.stopped") {
          void refreshThread(active.id).catch(() => undefined);
        } else if (isComputerStatusEvent(event)) {
          void refreshComputerStatus(active.id).catch(() => undefined);
        }
      },
    });
    return () => {
      abort.abort();
    };
  }, [active?.id, markBotReadIfVisible, notifyBrowserForEvent]);

  useEffect(() => {
    if (!groupId || !activeGroup) return;
    manuallyUnread.current.delete(activeGroup.id);
    readVisibleGroups.current.delete(groupId);
    const markVisibleGroupRead = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        readVisibleGroups.current.has(groupId)
      )
        return;
      readVisibleGroups.current.add(groupId);
      void rpc.threads
        .markRead({ groupId })
        .then(() => {
          setGroups((current) => {
            const group = current.find((candidate) => candidate.id === groupId);
            if (!group?.unread) return current;
            return current.map((candidate) =>
              candidate.id === groupId ? { ...candidate, unread: false } : candidate,
            );
          });
        })
        .catch(() => {
          readVisibleGroups.current.delete(groupId);
        });
    };
    markVisibleGroupRead();
    window.addEventListener("focus", markVisibleGroupRead);
    document.addEventListener("visibilitychange", markVisibleGroupRead);
    const pendingJump = searchParamsRef.current.get("m");
    if (!pendingJump) store.leaveJumpWindow();
    historyEpoch.current += 1;
    const abort = new AbortController();
    void runThreadSubscription({
      signal: abort.signal,
      loadInitial: () =>
        pendingJump
          ? rpc.threads.get({ groupId }, { signal: threadSnapshotSignal(abort.signal) })
          : refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      loadHead: () => rpc.threads.head({ groupId }, { signal: threadSnapshotSignal(abort.signal) }),
      refresh: () => refreshGroupThread(groupId, threadSnapshotSignal(abort.signal)),
      currentSnapshot: () => snapshotRef.current,
      subscribe: (cursor) => rpc.threads.subscribe({ groupId, cursor }, { signal: abort.signal }),
      applyEvent: (event) =>
        applyThreadEvent(
          event,
          commitSnapshot,
          commitComputer,
          snapshotRef,
          computerRef,
          computerBotId.current ?? null,
        ),
      onEvent: (event, initial) => {
        const eventBot = botsRef.current.find((bot) => bot.id === event.botId);
        notifyBrowserForEvent(
          event,
          initial.threadId,
          initial.cursor,
          true,
          eventBot?.name ?? activeGroup.name,
          true,
          true,
        );
        if (botWordsOf(event).length > 0) {
          readVisibleGroups.current.delete(groupId);
          markVisibleGroupRead();
        }
        if (event.type === "run.started" || isRunTerminalEvent(event)) {
          void refreshBots().catch(() => undefined);
        }
        // A started run is read back for whose it is, which its event does not say.
        if (event.type === "run.started" || isRunTerminalEvent(event)) {
          void refreshGroupThread(groupId).catch(() => undefined);
        } else if (isComputerStatusEvent(event) && event.botId === computerBotId.current) {
          void refreshComputerStatus(event.botId).catch(() => undefined);
        }
      },
    });
    return () => {
      window.removeEventListener("focus", markVisibleGroupRead);
      document.removeEventListener("visibilitychange", markVisibleGroupRead);
      abort.abort();
    };
  }, [activeGroup?.id, groupId, notifyBrowserForEvent]);

  const refreshThreadRef = useRef(refreshThread);
  refreshThreadRef.current = refreshThread;
  const refreshGroupThreadRef = useRef(refreshGroupThread);
  refreshGroupThreadRef.current = refreshGroupThread;
  // Transcript and MessageView are memoized; this must stay referentially stable or every
  // Shell state change re-renders the whole transcript.
  const refreshActiveThread = useCallback(async () => {
    const groupId = activeGroupId.current;
    if (groupId) {
      await refreshGroupThreadRef.current(groupId);
      return;
    }
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
  }, []);

  return {
    activityEpoch,
    refreshThread,
    refreshGroupThread,
    refreshThreadRef,
    refreshGroupThreadRef,
    refreshActiveThread,
  };
}

export type ThreadSync = ReturnType<typeof useThreadSync>;
