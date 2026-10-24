import type { Run } from "@rakazo/contracts";
import type { ThreadView } from "@rakazo/core";
import {
  answersPendingQuestion,
  drawsNothing,
  isActive,
  latestTakeoverItemId,
  projectThreadView,
} from "@rakazo/core";
import type { GroupAvatarMember } from "@rakazo/ui-web";
import { useCallback, useMemo, useRef } from "react";
import type { AskBlock } from "../../components/AskCard";
import { useDisplayAgentSteps } from "../../lib/agent-steps-pref";
import type { ArtifactTarget } from "../../lib/artifact-open";
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

export function messageIdOf(view: ThreadView, message: MessageItem): string | undefined {
  return view.rows.find((row) => row.item.id === message.id)?.messageId;
}

/** The card the thread waits on, and the run and entry its answer goes to: the one that asked last. */
export function waitingAsk(
  view: ThreadView,
): { block: AskBlock; target: Omit<CardAnswerTarget, "thread"> } | null {
  const waiting = view.waiting;
  if (!waiting) return null;
  const item = view.rows.find((row) => row.item.id === waiting.itemId)?.item;
  const block =
    item?.kind === "message"
      ? item.blocks.find(
          (candidate): candidate is AskBlock =>
            candidate.kind === "ask" && candidate.status !== "answered",
        )
      : item?.kind === "effect"
        ? item.card
        : undefined;
  return block ? { block, target: { runId: waiting.runId, messageId: waiting.entryId } } : null;
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
  const showSteps = useDisplayAgentSteps();
  const activeEntries = activeSnapshot?.entries;
  const activeLayer = activeSnapshot?.layer;
  const view = useMemo(
    () =>
      projectThreadView(activeEntries ?? [], {
        rendersNothing: (item) =>
          drawsNothing(item, (blocks) => hasRenderableBlock(blocks, showSteps)),
        progress: activeLayer,
      }),
    [activeEntries, activeLayer, showSteps],
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const rowIndexOf = useMemo(
    () => new Map(view.rows.map((row, index) => [row.item.id as string, index])),
    [view.rows],
  );
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
  // A send without a mention goes to the bot, or to a group's first member.
  const sendsTo = inGroup ? transcriptMembers?.[0]?.botId : active?.id;
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
