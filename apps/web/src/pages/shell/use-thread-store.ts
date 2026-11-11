import type { ComputerStatus, Routine, TaughtSkill, ThreadSnapshot } from "@tangow/contracts";
import type { HeldScreenUrl } from "@tangow/core";
import { threadEntriesOf } from "@tangow/core";
import { useRef, useState } from "react";
import { markOnce } from "../../lib/performance";
import type { ThreadState } from "../../lib/thread-events";

// Caps computerCacheRef so a long session that opens many distinct bots
// over time doesn't accumulate one entry per bot forever. Re-inserting on
// every update keeps Map iteration order as least-recently-used first, so
// eviction drops the bot that's been out of view longest.
const COMPUTER_CACHE_LIMIT = 20;

/**
 * The open conversation: its snapshot, its bot's computer, routines and taught
 * skills, and which window of its history the transcript shows.
 */
export function useThreadStore() {
  const [snapshot, setSnapshot] = useState<ThreadState | null>(null);
  const snapshotRef = useRef<ThreadState | null>(null);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const computerRef = useRef<ComputerStatus | null>(null);
  // A very fast run can finish over SSE while its threads.send response is still
  // returning. Do not let that late receipt resurrect terminal work as queued.
  const terminalRunReceipts = useRef(new Set<string>());
  // Last-known computer/screen per bot, so switching back to an already-seen
  // bot paints its computer pane instantly instead of blanking it while the
  // thread + screen RPCs round-trip again (see refreshThread / refreshComputerScreen).
  const computerCacheRef = useRef(
    new Map<string, { computer: ComputerStatus | null; screen?: HeldScreenUrl }>(),
  );
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const initiallyScrolledThread = useRef<string | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const followingEnd = useRef(true);
  const pinnedAroundRef = useRef<{ botId?: string; groupId?: string } | null>(null);

  function leaveJumpWindow({ snapToEnd = false } = {}) {
    const inWindow = expandedHistoryThread.current !== null || pinnedAroundRef.current !== null;
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    const element = messageScroll.current;
    if (snapToEnd && inWindow && element) {
      followingEnd.current = true;
      element.scrollTop = element.scrollHeight;
    }
  }

  function cacheComputerFor(
    botId: string,
    patch: Partial<{ computer: ComputerStatus | null; screen: HeldScreenUrl | undefined }>,
  ) {
    const cache = computerCacheRef.current;
    const prev = cache.get(botId) ?? { computer: null };
    cache.delete(botId);
    cache.set(botId, { ...prev, ...patch });
    if (cache.size > COMPUTER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }

  function commitSnapshot(next: ThreadState | null) {
    snapshotRef.current = next;
    setSnapshot(next);
  }

  function commitComputer(next: ComputerStatus | null) {
    computerRef.current = next;
    setComputer(next);
  }

  function updateSnapshot(update: (prev: ThreadState | null) => ThreadState | null) {
    commitSnapshot(update(snapshotRef.current));
  }

  function primeFromBootstrap(thread: ThreadSnapshot, threadRoutines: Routine[]) {
    bootstrappedThread.current = thread;
    commitSnapshot(threadEntriesOf(thread));
    commitComputer(thread.computer ?? null);
    setRoutines(threadRoutines);
    setRoutinesBotId(thread.botId ?? null);
    markOnce("rk:renderer:bots-response");
    markOnce("rk:renderer:thread-response");
  }

  return {
    snapshot,
    snapshotRef,
    commitSnapshot,
    updateSnapshot,
    computer,
    computerRef,
    commitComputer,
    computerCacheRef,
    cacheComputerFor,
    routines,
    setRoutines,
    routinesBotId,
    setRoutinesBotId,
    taughtSkills,
    setTaughtSkills,
    taughtSkillsBotId,
    setTaughtSkillsBotId,
    terminalRunReceipts,
    bootstrappedThread,
    primeFromBootstrap,
    expandedHistoryThread,
    historyEpoch,
    jumpGeneration,
    initiallyScrolledThread,
    messageScroll,
    followingEnd,
    pinnedAroundRef,
    leaveJumpWindow,
  };
}

export type ThreadStore = ReturnType<typeof useThreadStore>;
