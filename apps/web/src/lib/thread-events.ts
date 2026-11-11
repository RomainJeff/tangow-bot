import type {
  ComputerStatus,
  ProductEvent,
  Run,
  RunStatus,
  ThreadMessagePage,
  ThreadSnapshot,
} from "@rakazo/contracts";
import type { ProgressLayer } from "@rakazo/core";
import {
  applyEntryEvent,
  isActive,
  isRunTerminalEvent,
  reduceProgressLayer,
  runFailureError,
  threadEntriesOf,
  withOlderEntries,
  withRefreshedEntries,
} from "@rakazo/core";

export type ThreadState = Omit<ThreadSnapshot, "progress"> & { layer: ProgressLayer };

const runTriggers = new Set<Run["trigger"]>([
  "user",
  "routine",
  "resume",
  "follow_up",
  "spawn",
  "skill",
  "bot_message",
  "webhook",
  "messaging",
]);

function runFromStartedEvent(event: ProductEvent, previous: Run | undefined): Run {
  const trigger = event.payload.trigger;
  return {
    id: event.runId ?? previous?.id ?? event.id,
    botId: event.botId,
    userId: previous?.userId,
    threadId: event.threadId,
    taskId: previous?.taskId ?? event.runId ?? event.id,
    status: "running",
    trigger:
      typeof trigger === "string" && runTriggers.has(trigger as Run["trigger"])
        ? (trigger as Run["trigger"])
        : (previous?.trigger ?? "user"),
    routineId:
      typeof event.payload.routineId === "string"
        ? event.payload.routineId
        : (previous?.routineId ?? null),
    modelProvider: previous?.modelProvider ?? null,
    modelId: previous?.modelId ?? null,
    error: null,
    startedAt: previous?.startedAt ?? event.createdAt,
    completedAt: null,
    createdAt: previous?.createdAt ?? event.createdAt,
  };
}

const computerStates: ReadonlySet<unknown> = new Set<ComputerStatus["state"]>([
  "stopped",
  "booting",
  "running",
  "suspended",
  "error",
]);

export function activeThreadRuns(
  thread: Pick<ThreadState, "activeRuns" | "run"> | null,
): NonNullable<ThreadState["activeRuns"]> {
  return thread?.activeRuns ?? (thread?.run ? [thread.run] : []);
}

/**
 * Reflect a committed direct-message send before its follow-up snapshot arrives.
 *
 * threads.send returns only after the message and run are durable. Keeping that
 * receipt prevents a transient snapshot/SSE interruption from showing a stored
 * user bubble with no working state. A matching live run always wins, and the
 * next durable event or refresh still supplies the authoritative status.
 */
export function applyThreadSendReceipt(
  thread: ThreadState | null,
  receipt: { botId: string; runId: string; taskId: string; createdAt?: string },
  terminalRunIds: ReadonlySet<string> = new Set(),
): ThreadState | null {
  if (
    !thread ||
    thread.groupId ||
    thread.botId !== receipt.botId ||
    thread.run?.id === receipt.runId ||
    terminalRunIds.has(receipt.runId)
  ) {
    return thread;
  }
  const currentRuns = activeThreadRuns(thread);
  if (currentRuns.some((run) => isActive(run.status as RunStatus))) return thread;
  const createdAt = receipt.createdAt ?? new Date().toISOString();
  const run: Run = {
    id: receipt.runId,
    botId: receipt.botId,
    threadId: thread.threadId,
    taskId: receipt.taskId,
    status: "queued",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt,
  };
  return { ...thread, run, activeRuns: [run] };
}

/** Reason the newest run stopped, until the reader dismisses that run's failure. */
export function threadRunError(
  thread: Pick<ThreadState, "run"> | null,
  dismissedRunIds?: ReadonlySet<string>,
): string | null {
  const run = thread?.run;
  if (run?.status !== "failed" || dismissedRunIds?.has(run.id)) return null;
  return run.error ?? null;
}

export function clearActiveThreadRuns(thread: ThreadState): ThreadState {
  const runIds = new Set(activeThreadRuns(thread).map((run) => run.id));
  const computer = thread.computer?.busyBotName
    ? { ...thread.computer, busyBotName: null }
    : thread.computer;
  return {
    ...thread,
    run: null,
    activeRuns: [],
    layer: new Map([...thread.layer].filter(([runId]) => !runIds.has(runId))),
    computer,
  };
}

/** Whose each run is, from a refresh older than the live state, for runs only seen starting. */
function withRunPeople(prev: ThreadState, snap: ThreadSnapshot): ThreadState {
  const people = new Map(
    [snap.run, ...(snap.activeRuns ?? [])].flatMap((run) =>
      run?.userId ? [[run.id, run.userId] as const] : [],
    ),
  );
  const unknown = (run: Run | null | undefined) =>
    Boolean(run && !run.userId && people.has(run.id));
  if (!unknown(prev.run) && !prev.activeRuns?.some(unknown)) return prev;
  const owned = (run: Run) => (unknown(run) ? { ...run, userId: people.get(run.id) } : run);
  return {
    ...prev,
    run: prev.run && owned(prev.run),
    activeRuns: prev.activeRuns?.map(owned),
  };
}

/**
 * Apply a threads.get refresh without clobbering newer event-sourced takeover state.
 *
 * A refresh that started earlier can still return running+busyBotName after the client
 * already applied waiting_takeover. Cursor comparisons only apply within the same thread.
 * Stop clears run/busy optimistically in the shell because it has no terminal event; an
 * older-cursor refresh must keep that cleared local state (see Shell stopRun).
 */
export function reconcileRefreshedThread(
  prev: ThreadState | null,
  snap: ThreadSnapshot,
  prevComputer: ComputerStatus | null,
  preserveLoadedHistory = false,
): { snapshot: ThreadState; computer: ComputerStatus | null } {
  const sameThread = Boolean(prev && prev.threadId === snap.threadId);

  if (sameThread && prev && snap.cursor < prev.cursor) {
    // A subscription can advance the cursor with progress before the send-triggered refresh
    // returns the new run record. Hydrate that matching run without rolling the transcript back.
    // Optimistic stop drops the run's progress, so an older refresh cannot revive it.
    const refreshedRun = snap.run;
    if (!prev.run && refreshedRun && prev.layer.has(refreshedRun.id)) {
      return {
        snapshot: {
          ...prev,
          run: refreshedRun,
          activeRuns: snap.activeRuns,
          computer: snap.computer,
        },
        computer: snap.computer ?? null,
      };
    }
    // Progress can advance the thread cursor while embedded computer status from threads.get
    // is still useful — but only while a live run remains. Preserve event-sourced
    // waiting_takeover clears and optimistic stop clears.
    const preserveLocalComputer =
      prev.run?.status === "waiting_takeover" ||
      !prev.run ||
      !isActive(prev.run.status as RunStatus);
    return {
      snapshot: withRunPeople(prev, snap),
      computer: preserveLocalComputer ? prevComputer : (snap.computer ?? null),
    };
  }

  let snapshot: ThreadState = threadEntriesOf(snap);
  if (sameThread && prev) snapshot = withRefreshedEntries(prev, snapshot, preserveLoadedHistory);
  const computer = snap.computer ?? null;

  const localWaiting =
    sameThread &&
    prev?.run?.status === "waiting_takeover" &&
    snapshot.run?.id === prev.run.id &&
    snapshot.run.status !== "waiting_takeover" &&
    isActive(snapshot.run.status as RunStatus);

  if (localWaiting && snapshot.run) {
    const runId = snapshot.run.id;
    snapshot = {
      ...snapshot,
      run: { ...snapshot.run, status: "waiting_takeover" },
      activeRuns: snapshot.activeRuns?.map((run) =>
        run.id === runId ? { ...run, status: "waiting_takeover" } : run,
      ),
    };
  }

  return { snapshot, computer: clearBusyWhileWaitingTakeover(computer, snapshot.run?.status) };
}

/** A server read can lag the run events, so it must not bring the busy banner back while the bot waits for control. */
export function clearBusyWhileWaitingTakeover(
  computer: ComputerStatus | null,
  runStatus: string | undefined,
): ComputerStatus | null {
  return computer?.busyBotName && runStatus === "waiting_takeover"
    ? { ...computer, busyBotName: null }
    : computer;
}

export function prependThreadMessagePage(
  prev: ThreadState | null,
  page: ThreadMessagePage,
): ThreadState | null {
  if (!prev || prev.threadId !== page.threadId) return prev;
  return withOlderEntries(prev, page);
}

export function isThreadStateEvent(event: ProductEvent): boolean {
  return (
    event.type === "session.entry.appended" ||
    event.type === "thread.progress" ||
    event.type === "run.started" ||
    event.type === "computer.takeover.requested" ||
    isRunTerminalEvent(event)
  );
}

export function reduceThreadState(
  prev: ThreadState | null,
  event: ProductEvent,
): ThreadState | null {
  if (!prev) return prev;
  if (event.type === "session.entry.appended" || event.type === "thread.progress") {
    return applyEntryEvent(prev, event);
  }
  if (event.type === "run.started") {
    if (!event.runId) {
      return {
        ...prev,
        cursor: event.seq,
        members: updateMemberStatus(prev.members, event.botId, "running"),
      };
    }
    const previousRun =
      prev.activeRuns?.find((candidate) => candidate.id === event.runId) ??
      (prev.run?.id === event.runId ? prev.run : undefined);
    const run = runFromStartedEvent(event, previousRun);
    const without = (prev.activeRuns ?? (prev.run ? [prev.run] : [])).filter(
      (candidate) => candidate.id !== run.id,
    );
    // Bot threads keep a single primary run; groups accumulate concurrent member runs.
    const activeRuns = prev.groupId ? [...without, run] : [run];
    return {
      ...prev,
      cursor: event.seq,
      members: updateMemberStatus(prev.members, event.botId, "running"),
      // A group failure lives only in run; keep it until dismiss so a late member start
      // cannot wipe the banner (activeRuns still tracks the new work).
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns,
    };
  }
  if (event.type === "computer.takeover.requested") {
    const status = "waiting_takeover";
    const runId = event.runId;
    const knownInRun = Boolean(runId && prev.run?.id === runId);
    const knownInActive = Boolean(
      runId && prev.activeRuns?.some((candidate) => candidate.id === runId),
    );
    const needsInsert = Boolean(runId) && !knownInRun && !knownInActive;
    const runChanged = Boolean(knownInRun && prev.run && prev.run.status !== status);
    const activeRunChanged = Boolean(
      knownInActive &&
        prev.activeRuns?.some((candidate) => candidate.id === runId && candidate.status !== status),
    );
    const members = updateMemberStatus(prev.members, event.botId, status);
    if (!runChanged && !activeRunChanged && !needsInsert && members === prev.members) {
      return prev;
    }
    if (needsInsert && runId) {
      const waitingRun: Run = {
        id: runId,
        botId: event.botId,
        threadId: event.threadId,
        taskId: runId,
        status,
        trigger: "bot_message",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: event.createdAt,
        completedAt: null,
        createdAt: event.createdAt,
      };
      const baseActive = prev.activeRuns ?? (prev.run ? [prev.run] : []);
      const activeRuns = [...baseActive.filter((candidate) => candidate.id !== runId), waitingRun];
      const promoteWaiting =
        !prev.run ||
        (prev.run.status !== "waiting_input" && prev.run.status !== "waiting_takeover");
      return {
        ...prev,
        cursor: event.seq,
        members,
        run: promoteWaiting ? waitingRun : prev.run,
        activeRuns,
      };
    }
    return {
      ...prev,
      cursor: event.seq,
      members,
      run: runChanged && prev.run ? { ...prev.run, status } : prev.run,
      activeRuns: activeRunChanged
        ? prev.activeRuns?.map((candidate) =>
            candidate.id === runId ? { ...candidate, status } : candidate,
          )
        : prev.activeRuns,
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const nextMemberRun = activeRuns?.find((candidate) => candidate.botId === event.botId);
    const failure = runFailureError(event);
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    // In a group the failing run may be a member run rather than the displayed one, so look
    // it up in activeRuns as well or its error would be dropped with it.
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      ...prev,
      cursor: event.seq,
      layer: reduceProgressLayer(prev.layer, event),
      members: updateMemberStatus(prev.members, event.botId, nextMemberRun?.status ?? "idle"),
      // A failed run stays in run (activeRuns already excludes it) so the transcript can say
      // why it stopped, matching what threads.get returns on the next load.
      run:
        endedRun && failure
          ? { ...endedRun, status: "failed", error: failure }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  return prev;
}

function updateMemberStatus(
  members: ThreadState["members"],
  botId: string,
  status: string,
): ThreadState["members"] {
  const member = members?.find((candidate) => candidate.botId === botId);
  if (!member || member.status === status) return members;
  return members?.map((candidate) =>
    candidate.botId === botId ? { ...candidate, status } : candidate,
  );
}

export function userHoldsComputerControl(
  computer: Pick<ComputerStatus, "controlHolder" | "controlBotId"> | null | undefined,
  botId: string | undefined,
): boolean {
  return Boolean(botId && computer?.controlHolder === "user" && computer.controlBotId === botId);
}

/** True when a live bot run is blocking Take control (API would return 409). */
export function computerTakeoverBlocked(
  computer: Pick<ComputerStatus, "busyBotName"> | null | undefined,
  runStatus?: string | null,
): boolean {
  if (!computer?.busyBotName) return false;
  // waiting_takeover is the bot asking for control; terminal/idle clears the block even if
  // busyBotName is briefly stale while the executor still holds the lease in finally.
  if (!runStatus || runStatus === "waiting_takeover") return false;
  return isActive(runStatus as RunStatus);
}

/**
 * Whether the computer window offers Take control. On a bot shared with you, only when your own
 * run waits for you and nobody else has the screen; its owner may also take it whenever it is free.
 */
export function canTakeComputerControl(input: {
  shared: boolean;
  runStatus: string | null | undefined;
  composerRunning: boolean;
  busyBotName: string | null | undefined;
}): boolean {
  if (input.shared) return input.runStatus === "waiting_takeover" && !input.busyBotName;
  return input.runStatus === "waiting_takeover" || (!input.composerRunning && !input.busyBotName);
}

export function computerPanelAutoBoot(
  state: ComputerStatus["state"] | undefined,
  screenUrl?: string | null,
): "boot" | "recover-screen" | "wait" {
  if (state === "booting" || state === "suspended") return "wait";
  if (state === "running") return screenUrl ? "wait" : "recover-screen";
  return "boot";
}

/** Auto panel reconnect must use computer.boot — never computer.recover (that destroys the sandbox). */
export function computerPanelAutoUsesBoot(
  action: ReturnType<typeof computerPanelAutoBoot>,
): boolean {
  return action === "boot" || action === "recover-screen";
}

export function reduceComputerStatus(
  prev: ComputerStatus | null,
  event: ProductEvent,
): ComputerStatus | null {
  if (!prev) return prev;
  if (!isComputerStatusEvent(event)) return prev;
  if (event.type === "computer.takeover.requested") {
    const retainedControl = event.payload.retainedControl === true;
    const next = {
      ...prev,
      busyBotName: null,
      takeoverRequested: true,
      ...(retainedControl ? {} : { controlHolder: "none" as const, controlBotId: null }),
    };
    return prev.busyBotName === next.busyBotName &&
      prev.takeoverRequested === next.takeoverRequested &&
      prev.controlHolder === next.controlHolder &&
      prev.controlBotId === next.controlBotId
      ? prev
      : next;
  }
  if (event.type === "computer.takeover.granted") {
    const takeoverRequested = event.payload.takeoverRequested === true;
    return prev.controlHolder === "user" &&
      prev.controlBotId === event.botId &&
      prev.takeoverRequested === takeoverRequested &&
      prev.busyBotName === null
      ? prev
      : {
          ...prev,
          controlHolder: "user",
          controlBotId: event.botId,
          takeoverRequested,
          busyBotName: null,
        };
  }
  if (event.type === "computer.takeover.released") {
    const holder = event.payload.holder;
    if (holder !== "bot" && holder !== "none") return prev;
    return prev.controlHolder === holder &&
      prev.controlBotId === null &&
      !prev.takeoverRequested &&
      prev.busyBotName === null
      ? prev
      : {
          ...prev,
          controlHolder: holder,
          controlBotId: null,
          takeoverRequested: false,
          busyBotName: null,
        };
  }
  const status = event.payload.status;
  if (!isComputerState(status)) return prev;
  const screenAvailable = status === "running" || status === "booting" || prev.screenAvailable;
  if (status === prev.state && screenAvailable === prev.screenAvailable) return prev;
  return {
    ...prev,
    state: status,
    screenAvailable,
  };
}

export function isComputerStatusEvent(event: ProductEvent): boolean {
  return (
    event.type === "computer.status" ||
    event.type === "computer.takeover.requested" ||
    event.type === "computer.takeover.granted" ||
    event.type === "computer.takeover.released"
  );
}

function isComputerState(value: unknown): value is ComputerStatus["state"] {
  return computerStates.has(value);
}
