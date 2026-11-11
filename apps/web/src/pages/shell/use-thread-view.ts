import type { Run } from "@rakazo/contracts";
import type { ThreadView } from "@rakazo/core";
import {
  answersPendingQuestion,
  drawsNothing,
  groupLeadBotId,
  isActive,
  latestTakeoverItemId,
  projectThreadView,
  waitingAskBlock,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { useCallback, useMemo, useRef } from "react";
import type { AskBlock } from "../../components/AskCard";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useDebugMode } from "../../lib/debug-mode";
import { hasRenderableBlock } from "../../lib/message-blocks";
import { copyableMessageText } from "../../lib/message-text";
import type { ThreadState } from "../../lib/thread-events";
import { activeThreadRuns } from "../../lib/thread-events";
import type { CardAnswerTarget, MessageItem } from "../../lib/thread-items";
import type { CallThread } from "../CallView";
import { memberName } from "../GroupPanel";
import { FALLBACK_BOT_COLOR } from "./layout";
import type { Roster } from "./use-roster";

export function isWorking(
  run: Pick<Run, "id" | "status"> | null | undefined,
  view: ThreadView,
): boolean {
  return Boolean(
    run && ["running", "queued", "leased"].includes(run.status) && run.id !== view.waiting?.runId,
  );
}

/** The entry a message is stored as, whether it draws a row or sits in a stack of images behind its host's. */
export function messageIdOf(view: ThreadView, message: MessageItem): string | undefined {
  const rowId = view.rowOf.get(message.id) ?? message.id;
  const row = view.rows.find((candidate) => candidate.item.id === rowId);
  return row?.item.id === message.id ? row.messageId : row?.imageStack?.messageIds.get(message.id);
}

/** The card the thread waits on, and the run and entry its answer goes to: the one that asked last. */
export function waitingAsk(
  view: ThreadView,
): { block: AskBlock; target: Omit<CardAnswerTarget, "thread"> } | null {
  const waiting = view.waiting;
  const block = waitingAskBlock(view);
  return waiting && block
    ? { block, target: { runId: waiting.runId, messageId: waiting.entryId } }
    : null;
}

/** What the open thread's snapshot shows: its rows, who is working, and who a send answers. */
export function useThreadView(snapshot: ThreadState | null, roster: Roster) {
  const { groupId, inGroup, active, activeGroup, bots } = roster;
  const activeSnapshot = inGroup
    ? snapshot?.groupId === groupId
      ? snapshot
      : null
    : snapshot?.botId === active?.id
      ? snapshot
      : null;
  const showSteps = useDebugMode();
  const activeEntries = activeSnapshot?.entries;
  const activeLayer = activeSnapshot?.layer;
  const view = useMemo(
    () =>
      projectThreadView(activeEntries ?? [], {
        rendersNothing: (item) =>
          drawsNothing(item, (blocks) => hasRenderableBlock(blocks, showSteps)),
        progress: activeLayer,
        imageStacks: true,
      }),
    [activeEntries, activeLayer, showSteps],
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  // A message that joins a stack of images draws no row: it stands at its host's.
  const rowIndexOf = useMemo(() => {
    const indexOfRow = new Map(view.rows.map((row, index) => [row.item.id as string, index]));
    const indexes = new Map(indexOfRow);
    for (const [entryId, rowId] of view.rowOf) {
      const index = indexOfRow.get(rowId);
      if (index !== undefined && !indexes.has(entryId)) indexes.set(entryId, index);
    }
    return indexes;
  }, [view.rows, view.rowOf]);
  const currentRuns = useMemo(() => activeThreadRuns(activeSnapshot), [activeSnapshot]);
  const takeoverItemId = useMemo(
    () =>
      latestTakeoverItemId(
        view.rows.map((row) => row.item),
        currentRuns,
      ),
    [view.rows, currentRuns],
  );
  const workingRuns = currentRuns.filter((run) => isWorking(run, view));
  const transcriptRunning = workingRuns.length > 0;
  const composerRunning = currentRuns.some((run) => isActive(run.status));
  const messageItems = useMemo(
    () => view.rows.flatMap((row) => (row.item.kind === "message" ? [row.item] : [])),
    [view.rows],
  );
  // Dictation's language guess (`dictationLangFor`): the person's own recent
  // writing here, read lazily only when dictation actually starts.
  const recentWriting = useCallback(
    () =>
      messageItems
        .filter((message) => message.role === "user")
        .slice(-8)
        .map((message) => copyableMessageText(message)),
    [messageItems],
  );
  const transcriptArtifactTarget = useMemo<ArtifactTarget>(
    () => (inGroup ? { groupId: groupId ?? "" } : { botId: active?.id ?? "" }),
    [active?.id, groupId, inGroup],
  );
  const callThread = useMemo<CallThread>(() => {
    const ask = waitingAsk(view);
    return {
      messages: messageItems,
      running: isWorking(activeSnapshot?.run, view),
      ask: ask && {
        block: ask.block,
        target: { thread: transcriptArtifactTarget, ...ask.target },
      },
    };
  }, [view, messageItems, activeSnapshot?.run, transcriptArtifactTarget]);
  const transcriptMembers = activeSnapshot?.members ?? activeGroup?.members;
  const resolveTranscriptBot = useCallback(
    (botId: string) => {
      const bot = bots.find((candidate) => candidate.id === botId);
      if (bot) return bot;
      return transcriptMembers?.find((member) => member.botId === botId);
    },
    [bots, transcriptMembers],
  );
  // A send without a mention goes to the bot, or to a group's lead.
  const sendsTo = inGroup
    ? groupLeadBotId(
        (transcriptMembers ?? []).map((member) => ({ id: member.botId })),
        activeGroup?.leadBotId,
      )
    : active?.id;
  const answerName =
    sendsTo && answersPendingQuestion(view, sendsTo, currentRuns)
      ? resolveTranscriptBot(sendsTo)?.name
      : undefined;
  const workingBots: GroupAvatarMember[] = workingRuns.map((run) => {
    const bot = resolveTranscriptBot(run.botId);
    return {
      botId: run.botId,
      color: bot?.color ?? FALLBACK_BOT_COLOR,
      shapeSeed: bot?.shapeSeed,
      name: bot?.name,
      status: run.status,
    };
  });
  // The working line's clock reads from when the run actually started, not
  // from whenever the transcript happened to mount.
  const workingStartedAt =
    workingRuns.length > 0
      ? Math.min(...workingRuns.map((run) => new Date(run.startedAt ?? run.createdAt).getTime()))
      : undefined;
  const resolveTranscriptMemberName = useCallback(
    (botId: string | undefined) => memberName(transcriptMembers, botId),
    [transcriptMembers],
  );

  return {
    activeSnapshot,
    view,
    viewRef,
    rowIndexOf,
    transcriptRunning,
    composerRunning,
    takeoverItemId,
    recentWriting,
    callThread,
    transcriptArtifactTarget,
    resolveTranscriptBot,
    resolveTranscriptMemberName,
    answerName,
    workingBots,
    workingStartedAt,
  };
}

export type ThreadViewState = ReturnType<typeof useThreadView>;
