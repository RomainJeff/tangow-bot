import { useLingui } from "@lingui/react/macro";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@tangow/contracts";
import { attachmentsForThread, inferAttachmentMimeType } from "@tangow/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyableMessageText } from "../../lib/message-text";
import { revokePendingAttachmentPreviews } from "../../lib/pending-attachments";
import { readSeenRunErrorIds, rememberSeenRunErrorId } from "../../lib/run-error-storage";
import { threadRunError } from "../../lib/thread-events";
import type { MessageItem } from "../../lib/thread-items";
import type { PendingAttachment } from "./layout";
import type { Roster } from "./use-roster";
import type { ThreadViewState } from "./use-thread-view";

/**
 * The composer's state around the text itself: attachments, the message it
 * replies to or rewinds from, and the notice or error it shows.
 */
export function useComposerDraft({ roster, thread }: { roster: Roster; thread: ThreadViewState }) {
  const { t } = useLingui();
  const { active, groupId, inGroup, activeBotId, activeGroupId } = roster;
  const { activeSnapshot, view, rowIndexOf, resolveTranscriptMemberName, personOf } = thread;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<MessageItem | null>(null);
  const [rewindTarget, setRewindTarget] = useState<MessageItem | null>(null);
  const [rewindArtifacts, setRewindArtifacts] = useState<{ id: string; name: string }[]>([]);
  // `key` re-seeds the composer draft: once when rewind starts, again when a failed send
  // has to hand the typed text back.
  const [rewindDraft, setRewindDraft] = useState<{
    key: string;
    text: string;
    linkPreviewRemoved?: boolean;
  } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dismissedRunErrorIds, setDismissedRunErrorIds] =
    useState<ReadonlySet<string>>(readSeenRunErrorIds);
  const activePendingAttachments = useMemo(
    () => attachmentsForThread(pendingAttachments, inGroup ? groupId : active?.id),
    [active?.id, groupId, inGroup, pendingAttachments],
  );
  const activeReplyTarget = replyTarget && rowIndexOf.has(replyTarget.id) ? replyTarget : null;
  const activeRewindTarget = rewindTarget && rowIndexOf.has(rewindTarget.id) ? rewindTarget : null;
  const runError = threadRunError(activeSnapshot, dismissedRunErrorIds);
  const displayedRunError = !sendError ? runError : null;
  const displayedRunErrorId = displayedRunError ? (activeSnapshot?.run?.id ?? null) : null;
  const handleRunErrorPresented = useCallback((runId: string) => {
    rememberSeenRunErrorId(runId);
  }, []);
  const replyTargetName = activeReplyTarget
    ? activeReplyTarget.role === "user"
      ? (personOf(activeReplyTarget)?.name ?? t`You`)
      : (resolveTranscriptMemberName(activeReplyTarget.botId) ?? active?.name ?? t`Bot`)
    : undefined;
  const rewindIndex = activeRewindTarget ? (rowIndexOf.get(activeRewindTarget.id) ?? -1) : -1;
  const rewindRemovedCount =
    rewindIndex < 0
      ? 0
      : view.rows.slice(rewindIndex + 1).filter((row) => row.item.kind === "message").length;
  const cancelRewind = useCallback(() => {
    setRewindTarget(null);
    setRewindArtifacts([]);
    setRewindDraft(null);
  }, []);
  const startRewind = useCallback((message: MessageItem) => {
    setReplyTarget(null);
    setRewindTarget(message);
    setRewindArtifacts(
      message.blocks.flatMap((block) =>
        block.kind === "image" || block.kind === "file"
          ? [{ id: block.artifactId, name: block.name }]
          : [],
      ),
    );
    setRewindDraft({ key: message.id, text: copyableMessageText(message) });
  }, []);
  const onAttachmentPick = useCallback(
    async (files: FileList | null) => {
      const threadKey = activeGroupId.current ?? activeBotId.current;
      if (!threadKey || !files?.length) return;
      const existing = attachmentsForThread(pendingAttachments, threadKey);
      const next: PendingAttachment[] = [];
      const skipped: string[] = [];
      for (const file of Array.from(files)) {
        if (existing.length + next.length >= ATTACHMENT_MAX_COUNT) {
          skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
          continue;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          skipped.push(t`${file.name} (over 10 MiB)`);
          continue;
        }
        const mimeType = inferAttachmentMimeType(file.name, file.type);
        if (!mimeType) {
          skipped.push(file.name);
          continue;
        }
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`,
          threadKey,
          file,
          previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      if (next.length) setPendingAttachments((current) => [...current, ...next]);
      setAttachmentNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [pendingAttachments, t],
  );
  const removeAttachment = useCallback((attachment: PendingAttachment) => {
    revokePendingAttachmentPreviews([attachment]);
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
  }, []);

  useEffect(() => {
    const threadKey = inGroup ? groupId : active?.id;
    setPendingAttachments((current) => {
      const stale = current.filter((attachment) => attachment.threadKey !== threadKey);
      revokePendingAttachmentPreviews(stale);
      return attachmentsForThread(current, threadKey);
    });
    setReplyTarget(null);
    cancelRewind();
    setAttachmentNotice(null);
    setSendError(null);
  }, [active?.id, groupId, inGroup, cancelRewind]);

  function dismissComposerError() {
    // The strip shows one message at a time, so only dismiss the run failure when it is the
    // one on screen; otherwise a live run would be silenced before it has even failed.
    const failedRunId = displayedRunErrorId;
    setSendError(null);
    if (failedRunId) {
      rememberSeenRunErrorId(failedRunId);
      setDismissedRunErrorIds((current) => new Set(current).add(failedRunId));
    }
  }

  return {
    pendingAttachments,
    setPendingAttachments,
    activePendingAttachments,
    attachmentNotice,
    setAttachmentNotice,
    fileInputRef,
    onAttachmentPick,
    removeAttachment,
    setReplyTarget,
    activeReplyTarget,
    replyTargetName,
    activeRewindTarget,
    rewindArtifacts,
    setRewindArtifacts,
    rewindDraft,
    setRewindDraft,
    rewindRemovedCount,
    startRewind,
    cancelRewind,
    sendError,
    setSendError,
    displayedRunError,
    displayedRunErrorId,
    handleRunErrorPresented,
    dismissComposerError,
  };
}

export type ComposerDraft = ReturnType<typeof useComposerDraft>;
