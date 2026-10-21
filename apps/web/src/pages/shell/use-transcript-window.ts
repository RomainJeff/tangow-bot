import { EntryId } from "@rakazo/contracts";
import { searchHitThreadTarget, threadEntriesOf } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import { rpc } from "../../lib/rpc";
import { prependThreadMessagePage } from "../../lib/thread-events";
import type { BotPageView } from "./layout";
import type { Roster } from "./use-roster";
import type { ThreadStore } from "./use-thread-store";
import type { ThreadViewState } from "./use-thread-view";

/**
 * Which part of the thread's history the transcript shows: the first scroll to
 * the end, older pages, and jumps to a message from a link, a search or a reply.
 */
export function useTranscriptWindow({
  roster,
  store,
  viewRef,
  searchParams,
  setSearchParams,
  refreshRoutines,
  showBotPage,
}: {
  roster: Roster;
  store: ThreadStore;
  viewRef: RefObject<ThreadViewState["view"]>;
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  refreshRoutines: (botId: string) => Promise<void>;
  showBotPage: (view: BotPageView) => void;
}) {
  const { active, groupId, inGroup, activeBotId, activeGroupId } = roster;
  const { snapshot, routines, routinesBotId, commitSnapshot, commitComputer } = store;
  const { expandedHistoryThread, historyEpoch, jumpGeneration, initiallyScrolledThread } = store;
  const { messageScroll, pinnedAroundRef } = store;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const routineRefetched = useRef(new Set<string>());
  // The `?m=` jump already started: a re-render before the link is stripped (new routines) must not repeat it.
  const linkJump = useRef<string | null>(null);

  async function loadOlderMessages() {
    const targetBotId = inGroup ? undefined : active?.id;
    const targetGroupId = inGroup ? groupId : undefined;
    const snapshotMatchesTarget = targetGroupId
      ? snapshot?.groupId === targetGroupId
      : snapshot?.botId === targetBotId;
    if (
      (!targetBotId && !targetGroupId) ||
      !snapshotMatchesTarget ||
      snapshot?.olderCursor == null ||
      loadingOlder
    )
      return;
    pinnedAroundRef.current = null;
    const scrollElement = messageScroll.current;
    const previousHeight = scrollElement?.scrollHeight ?? 0;
    const epoch = historyEpoch.current;
    const before = snapshot.olderCursor;
    setLoadingOlder(true);
    try {
      const page = await rpc.threads.messages({
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        before,
      });
      if (
        epoch !== historyEpoch.current ||
        activeBotId.current !== targetBotId ||
        activeGroupId.current !== targetGroupId
      )
        return;
      expandedHistoryThread.current = page.threadId;
      store.updateSnapshot((prev) => prependThreadMessagePage(prev, page));
      window.requestAnimationFrame(() => {
        const element = messageScroll.current;
        if (element) element.scrollTop += element.scrollHeight - previousHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  async function jumpToMessage(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = searchHitThreadTarget(target);
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [snap, page] = await Promise.all([
      rpc.threads.get(threadTarget),
      rpc.threads.messages({
        ...threadTarget,
        around: { entryId: EntryId.parse(target.messageId) },
      }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch): applying
    // the fetched page would pin deleted messages that every later refresh keeps restoring.
    // jumpId drops an older jump that finished after a newer click.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const targetInPage = page.entries.some((entry) => entry.id === target.messageId);
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage ? threadTarget : null;
    if (targetInPage) initiallyScrolledThread.current = page.threadId;
    commitSnapshot(
      targetInPage
        ? { ...threadEntriesOf(snap), entries: page.entries, olderCursor: page.olderCursor }
        : threadEntriesOf(snap),
    );
    if (threadTarget.botId) {
      commitComputer(snap.computer ?? null);
      // Don't block parent-scroll on routines metadata; a list failure must not abort the jump.
      void refreshRoutines(threadTarget.botId).catch(() => undefined);
    } else {
      commitComputer(null);
      store.setRoutines([]);
      store.setRoutinesBotId(null);
    }
    window.requestAnimationFrame(() => {
      if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
      if (!targetInPage) {
        const element = messageScroll.current;
        if (element) {
          element.scrollTop = element.scrollHeight;
          initiallyScrolledThread.current = page.threadId;
        }
        return;
      }
      const rowId = viewRef.current.rowOf.get(target.messageId) ?? target.messageId;
      document
        .querySelector(`[data-message-id="${CSS.escape(rowId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  useEffect(() => {
    const messageId = searchParams.get("m");
    const routineId = searchParams.get("routine");
    if (!messageId) linkJump.current = null;
    if (inGroup && groupId && messageId) {
      if (linkJump.current === messageId) return;
      linkJump.current = messageId;
      void jumpToMessage({ groupId, messageId }).finally(() => {
        // Keep expandedHistoryThread; only strip the jump URL so refresh does not remount.
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
      return;
    }
    if (!active) return;
    if (routineId && routinesBotId === active.id) {
      const routine = routines.find((item) => item.id === routineId);
      // A routine the bot just created may be newer than the list: fetch it once before giving up.
      if (!routine && !routineRefetched.current.has(routineId)) {
        routineRefetched.current.add(routineId);
        void refreshRoutines(active.id).catch(() => undefined);
        return;
      }
      showBotPage({
        tab: "routines",
        detail: routine ? { kind: "routine", routineId: routine.id } : null,
      });
      const next = new URLSearchParams(searchParams);
      next.delete("routine");
      setSearchParams(next, { replace: true });
    }
    if (messageId && linkJump.current !== messageId) {
      linkJump.current = messageId;
      void jumpToMessage({ botId: active.id, messageId }).finally(() => {
        const next = new URLSearchParams(searchParams);
        next.delete("m");
        setSearchParams(next, { replace: true });
      });
    }
  }, [
    active?.id,
    groupId,
    inGroup,
    routines,
    routinesBotId,
    searchParams,
    setSearchParams,
    showBotPage,
  ]);

  useLayoutEffect(() => {
    const pin = pinnedAroundRef.current;
    if (inGroup) {
      if (!groupId || !snapshot || snapshot.groupId !== groupId) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.groupId === groupId) return;
    } else {
      if (!active || !snapshot || snapshot.botId !== active.id) return;
      if (initiallyScrolledThread.current === snapshot.threadId) return;
      if (expandedHistoryThread.current === snapshot.threadId) return;
      if (pin?.botId === active.id) return;
    }
    const element = messageScroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    initiallyScrolledThread.current = snapshot.threadId;
  }, [active, groupId, inGroup, snapshot?.botId, snapshot?.groupId, snapshot?.threadId]);

  const loadOlderMessagesRef = useRef(loadOlderMessages);
  loadOlderMessagesRef.current = loadOlderMessages;
  const jumpToMessageRef = useRef(jumpToMessage);
  jumpToMessageRef.current = jumpToMessage;
  const loadOlder = useCallback(() => loadOlderMessagesRef.current(), []);
  const jumpToReplyMessage = useCallback((messageId: string) => {
    const rowId = viewRef.current.rowOf.get(messageId) ?? messageId;
    const existing = document.querySelector(`[data-message-id="${CSS.escape(rowId)}"]`);
    if (existing) {
      // Cancel any in-flight around-fetch so it cannot overwrite this scroll.
      jumpGeneration.current += 1;
      existing.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const groupId = activeGroupId.current;
    if (groupId) {
      void jumpToMessageRef.current({ groupId, messageId });
      return;
    }
    const botId = activeBotId.current;
    if (botId) void jumpToMessageRef.current({ botId, messageId });
  }, []);

  return { loadingOlder, loadOlder, jumpToReplyMessage };
}

export type TranscriptWindow = ReturnType<typeof useTranscriptWindow>;
