import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry, ThreadMessage } from "@rakazo/contracts";
import { ATTACHMENT_ALLOWED_MIME_TYPES } from "@rakazo/contracts";
import type { ComposerMention, SlashActionId } from "@rakazo/core";
import {
  clampMentionHighlightIndex,
  mentionChipKey,
  resolveMentionPickerKey,
  SLASH_ACTIONS,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "@rakazo/core";
import type { ComposerState } from "@rakazo/ui-web";
import { BotAvatar, Button, ComposerAttachment, ComposerShell, StopContour } from "@rakazo/ui-web";
import { ArrowUp, Box, Check, Clock, Mic, Pencil, Plus, Puzzle, Settings, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, RefObject } from "react";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopBridge } from "../../lib/desktop.js";
import { dictation, webSpeechAvailable } from "../../lib/dictation.js";
import { isFileDrag, isFilePaste } from "../../lib/pending-attachments";
import type { PendingAttachment } from "./layout";
import { FALLBACK_BOT_COLOR } from "./layout";
import { previewMessageText } from "./message-view";

const ATTACHMENT_ACCEPT = ATTACHMENT_ALLOWED_MIME_TYPES.join(",");

export const Composer = memo(function Composer({
  activeName,
  running,
  botColor,
  disabled,
  pendingAttachments,
  attachmentNotice,
  sendError,
  runError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  onStop,
  dictationTranscribe,
  replyTarget,
  replyTargetName,
  onClearReply,
  rewindTarget,
  rewindDraft,
  rewindRemovedCount,
  rewindArtifacts,
  onCancelRewind,
  onRemoveRewindArtifact,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  onSlashAction,
}: {
  activeName?: string;
  running: boolean;
  /** The responding bot's identity colour (data, not a token); omitted in a group. */
  botColor?: string;
  disabled?: boolean;
  pendingAttachments: PendingAttachment[];
  attachmentNotice: string | null;
  sendError: string | null;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | null) => void | Promise<void>;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (text: string, mentions?: ComposerMention[]) => Promise<void>;
  onStop: () => Promise<void>;
  /** Whether the configured voice provider can transcribe — the dictation
   * engine used when Web Speech isn't available (Electron, most non-Chrome
   * browsers). */
  dictationTranscribe?: boolean;
  replyTarget?: ThreadMessage | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  rewindTarget?: ThreadMessage | null;
  rewindDraft?: { key: string; text: string } | null;
  rewindRemovedCount?: number;
  rewindArtifacts?: { id: string; name: string }[];
  onCancelRewind?: () => void;
  onRemoveRewindArtifact?: (artifactId: string) => void;
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const runErrorRef = useRef<HTMLDivElement>(null);
  const presentedRunErrorIdRef = useRef<string | null>(null);
  const mentionListboxId = useId();
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const canSend =
    draft.trim().length > 0 ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    pendingAttachments.length > 0 ||
    (rewindArtifacts?.length ?? 0) > 0;

  // Dictation: the mic turns speech into text in the field; nothing is ever
  // sent on its own. `dictateSnapshotRef` freezes the draft/chips at the tap
  // so × can restore them exactly; `isDictatingRef` mirrors `isDictating` so
  // the `dictation.subscribe` effect below (mounted once) always reads the
  // latest without resubscribing on every render.
  const [isDictating, setIsDictating] = useState(false);
  const isDictatingRef = useRef(false);
  isDictatingRef.current = isDictating;
  const [dictateSpeech, setDictateSpeech] = useState({ committed: "", interim: "" });
  const dictateSnapshotRef = useRef<{
    draft: string;
    mentions: ComposerMention[];
    skill: AgentSkillCatalogEntry | null;
  } | null>(null);
  const dictateInsertingRef = useRef(false);
  const dictateActivityRef = useRef(0);
  const dictateStartedRef = useRef(0);
  // Only a genuinely new final/interim result counts as activity for the 60s
  // silence cap — a natural engine restart re-announces the same committed
  // text with an empty interim tail, which must not look like fresh speech.
  const dictateLastSpeechRef = useRef({ transcript: "", interim: "" });
  const dictationPreviewRef = useRef<HTMLDivElement>(null);
  // ✓ on the recorder fallback (no Web Speech) has to wait for the last
  // in-flight chunk transcription before it knows the final text; this
  // tracks that brief window so the UI can show it and × can still cut in.
  const [dictateFinishing, setDictateFinishing] = useState(false);
  const dictateFinishingRef = useRef(false);
  dictateFinishingRef.current = dictateFinishing;
  const dictateFinishCancelledRef = useRef(false);
  const speechAvailable = useMemo(() => webSpeechAvailable(), []);
  const dictationAvailable = speechAvailable || Boolean(dictationTranscribe);
  // Electron's Chromium reports Web Speech as available but it usually has no
  // speech-service key configured there, so on desktop the configured voice
  // provider is tried first when it can transcribe (dictation.ts also falls
  // back to it if Web Speech then fails to start).
  const preferTranscribe = Boolean(desktopBridge()) && Boolean(dictationTranscribe);

  // The Stop contour carries the "a run is going" signal now; the shell's own
  // state only distinguishes an empty field from one that can send.
  const composerState: ComposerState = isDictating ? "dictating" : canSend ? "typing" : "idle";
  const rewindTime = rewindTarget
    ? new Date(rewindTarget.createdAt).toLocaleTimeString(i18n.locale || "en", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  const rewindDraftKey = rewindDraft?.key ?? null;
  const rewindDraftText = rewindDraft?.text ?? "";

  useEffect(() => {
    if (!rewindDraftKey) return;
    setDraft(rewindDraftText);
    textareaRef.current?.focus();
  }, [rewindDraftKey, rewindDraftText]);

  function exitDictationAsForcedCancel() {
    setIsDictating(false);
    const snapshot = dictateSnapshotRef.current;
    const wasActive = snapshot !== null;
    dictateSnapshotRef.current = null;
    if (snapshot) {
      setDraft(snapshot.draft);
      setSelectedMentions(snapshot.mentions);
      setSelectedSkill(snapshot.skill);
    }
    setDictateSpeech({ committed: "", interim: "" });
    window.requestAnimationFrame(() => textareaRef.current?.focus());
    // Defensive: whatever left dictation should already have stopped the
    // engine itself, but this exit is the one place the composer leaves
    // dictation, so make sure nothing can keep the mic running behind it.
    // `stop()` is idempotent — a no-op once the session already ended.
    if (wasActive) dictation.stop("cancel");
  }

  // The single place dictation actually exits: subscribing (not calling
  // stop() reactively) means × (below), a forced cancel, and the shared
  // `dictation` instance being cut off from elsewhere (starting the call)
  // all funnel through the same restore. `insertDictation` is the one path
  // that already made its own exit and sets `dictateInsertingRef` first so
  // this effect leaves its result alone.
  useEffect(() => {
    const unsubscribe = dictation.subscribe((snapshot) => {
      if (!isDictatingRef.current) return;
      if (snapshot.status !== "idle") {
        const transcript = snapshot.transcript;
        const interim = snapshot.interim ?? "";
        const last = dictateLastSpeechRef.current;
        // A natural restart re-announces the same committed text with the
        // interim tail reset to "" — that reset alone isn't new speech, only
        // a longer transcript or a genuinely new (non-empty) interim is.
        const isNewSpeech =
          transcript !== last.transcript || (interim !== "" && interim !== last.interim);
        if (isNewSpeech) dictateActivityRef.current = Date.now();
        dictateLastSpeechRef.current = { transcript, interim };
        setDictateSpeech({ committed: transcript, interim });
        return;
      }
      if (dictateInsertingRef.current) return;
      exitDictationAsForcedCancel();
    });
    return () => {
      unsubscribe();
      if (isDictatingRef.current) dictation.stop("cancel");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isDictating) return;
    function forceCancelIfHidden() {
      // A ✓ already in flight (waiting on the last chunk's transcription) is
      // a bounded wait, not idle listening — don't cut it off.
      if (dictateFinishingRef.current) return;
      if (document.hidden) dictation.stop("cancel");
    }
    const interval = setInterval(() => {
      if (dictateFinishingRef.current) return;
      const now = Date.now();
      const silentTooLong = now - dictateActivityRef.current > 60_000;
      const sessionTooLong = now - dictateStartedRef.current > 5 * 60_000;
      if (silentTooLong || sessionTooLong) dictation.stop("cancel");
    }, 2_000);
    document.addEventListener("visibilitychange", forceCancelIfHidden);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", forceCancelIfHidden);
    };
  }, [isDictating]);

  function startDictation() {
    if (disabled || isDictating || !dictationAvailable) return;
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSlashQuery(null);
    dictateSnapshotRef.current = { draft, mentions: selectedMentions, skill: selectedSkill };
    setDictateSpeech({ committed: "", interim: "" });
    dictateLastSpeechRef.current = { transcript: "", interim: "" };
    dictateActivityRef.current = Date.now();
    dictateStartedRef.current = Date.now();
    setIsDictating(true);
    window.requestAnimationFrame(() => dictationPreviewRef.current?.focus());
    void dictation.listen({
      mode: "dictate",
      transcribe: dictationTranscribe,
      preferTranscribe,
      // Dictate mode never finishes on its own (no silence endpoint, and a
      // natural restart keeps listening) — only ✓/×/forced-cancel end it,
      // all read live off `dictation.state` instead of this callback.
      onFinal: () => undefined,
    });
  }

  function cancelDictation() {
    if (!isDictating) return;
    if (dictateInsertingRef.current) {
      // ✓ is waiting on the recorder fallback's last chunk — × still cancels
      // immediately: restore now and mark it so the pending insert discards
      // whatever text finishes transcribing afterwards.
      dictateFinishCancelledRef.current = true;
      dictation.stop("cancel");
      exitDictationAsForcedCancel();
      return;
    }
    dictation.stop("cancel");
  }

  async function insertDictation() {
    if (!isDictating || dictateFinishing) return;
    const snapshot = dictateSnapshotRef.current;
    setDictateFinishing(true);
    dictateInsertingRef.current = true;
    dictateFinishCancelledRef.current = false;
    // On Web Speech this resolves right away (the text is already live); on
    // the recorder fallback it waits for the in-flight/last chunk, bounded by
    // the transcription timeout. The `finally` clears the finishing state
    // even if a × landing in that window (or anything else) makes it settle
    // early, so the composer never gets stuck with ✓ disabled.
    let dictated = "";
    try {
      dictated = await dictation.finishDictate();
    } finally {
      dictateInsertingRef.current = false;
      setDictateFinishing(false);
    }
    if (dictateFinishCancelledRef.current) {
      dictateFinishCancelledRef.current = false;
      return;
    }
    setIsDictating(false);
    dictateSnapshotRef.current = null;
    setDictateSpeech({ committed: "", interim: "" });
    const merged = snapshot?.draft
      ? dictated
        ? `${snapshot.draft} ${dictated}`
        : snapshot.draft
      : dictated;
    setDraft(merged);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(merged.length, merged.length);
    });
  }

  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    let frame = 0;
    function recordIfPresented() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = runErrorRef.current;
        if (!element || document.visibilityState !== "visible") return;
        const rect = element.getBoundingClientRect();
        const topElement = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        if (topElement && (topElement === element || element.contains(topElement))) {
          if (presentedRunErrorIdRef.current === currentRunErrorId) return;
          presentedRunErrorIdRef.current = currentRunErrorId;
          onRunErrorPresented(currentRunErrorId);
        }
      });
    }
    recordIfPresented();
    const observer = new MutationObserver(recordIfPresented);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("transitionend", recordIfPresented);
    document.addEventListener("visibilitychange", recordIfPresented);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("transitionend", recordIfPresented);
      document.removeEventListener("visibilitychange", recordIfPresented);
    };
  }, [onRunErrorPresented, runError, runErrorId]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    function syncHeight() {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.style.height = "0px";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }

    syncHeight();
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const width = textarea.getBoundingClientRect().width;
      if (width === lastWidth) return;
      lastWidth = width;
      syncHeight();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // The textarea unmounts while dictating (swapped for the read-only
    // preview) and remounts with no inline height on exit — re-run once
    // `isDictating` flips back so a multi-line draft re-measures instead of
    // coming back as a single line.
  }, [draft, isDictating]);

  // The dictation preview keeps the newest words in view once the text
  // outgrows the field's height cap, instead of leaving them scrolled out of
  // sight below the fold.
  useEffect(() => {
    if (!isDictating) return;
    const el = dictationPreviewRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isDictating, dictateSpeech]);

  function updateDraft(value: string) {
    setDraft(value);
    const mentionMatch = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(mentionMatch ? (mentionMatch[1] ?? "") : null);
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function focusComposer() {
    textareaRef.current?.focus();
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) => current.replace(/@([\w-]*)$/, ""));
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
    focusComposer();
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
    setSlashQuery(null);
    onSlashAction?.(action);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightIndex(0);
  }, [mentionQuery, mentionOptions]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionHighlightIndex,
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    const skills = agentSkills ?? [];
    return skills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }, [agentSkills, slashQuery]);

  const slashActionOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    return SLASH_ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query));
  }, [slashQuery]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  function send() {
    if (!canSend || sending || disabled) return;
    const text = serializeComposerPrompt(draft, selectedSkill, selectedMentions);
    setDraft("");
    setMentionQuery(null);
    setMentionHighlightIndex(0);
    setSlashQuery(null);
    setSelectedSkill(null);
    const mentions = selectedMentions;
    setSelectedMentions([]);
    void onSend(text, mentions);
    const shell = shellRef.current;
    if (shell && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      shell.animate([{ transform: "scale(0.99)" }, { transform: "scale(1)" }], {
        duration: 180,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
  }

  // Attachments stay unchanged while dictating: a file dropped or pasted in
  // is ignored the same way it already is while `disabled`.
  const dropDisabled = disabled || isDictating;

  function handleDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    if (dropDisabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = dropDisabled ? "none" : "copy";
    if (dropDisabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    setDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    if (dropDisabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!dropDisabled) void onAttachmentPick(dataTransfer.files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardData = event.clipboardData;
    // Only intercept real FileList pastes; leave text-only / empty-files native.
    // (The textarea itself is unmounted while dictating, but this keeps the
    // guard true even if that ever changes.)
    if (dropDisabled || !clipboardData || !isFilePaste(clipboardData)) return;
    event.preventDefault();
    void onAttachmentPick(clipboardData.files);
    const text = clipboardData.getData("text/plain");
    if (!text) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    updateDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`);
    const caret = start + text.length;
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  const showComposerPlaceholder =
    draft.length === 0 && selectedSkill === null && selectedMentions.length === 0;
  const replyName = replyTarget ? (replyTargetName ?? previewMessageText(replyTarget)) : "";

  return (
    <fieldset
      aria-label={t`Message composer`}
      data-dragging={draggingFiles ? "files" : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative z-30 m-0 min-w-0 border-0 pb-4 pt-3 md:pb-6 ${
        draggingFiles ? "rounded-card ring-2 ring-inset ring-ring" : ""
      }`}
    >
      {sendError || runError ? (
        <div
          ref={runErrorRef}
          role="alert"
          data-testid="composer-error"
          className="mb-3 flex items-center gap-2 rounded-card border border-destructive/40 bg-destructive/10 px-4 py-2 text-meta text-destructive"
        >
          <span className="min-w-0 flex-1">{sendError ?? runError}</span>
          <button
            type="button"
            aria-label={t`Dismiss error`}
            data-testid="composer-error-dismiss"
            onClick={() => {
              onDismissError();
              window.requestAnimationFrame(() => textareaRef.current?.focus());
            }}
            className="shrink-0 text-destructive hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {replyTarget ? (
        <div
          data-testid="reply-chip"
          className="mb-2 flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-meta text-foreground/75"
        >
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{t`Replying to ${replyName}`}</span>
          <button
            type="button"
            aria-label={t`Cancel reply`}
            onClick={onClearReply}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {rewindTarget ? (
        <div
          data-testid="rewind-chip"
          className="mb-2 flex items-center gap-2 rounded-full border border-border bg-sidebar-border px-3 py-1.5 text-meta text-foreground"
        >
          <Pencil size={13} strokeWidth={1.8} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {t`Editing message from ${rewindTime} · ${rewindRemovedCount ?? 0} messages after it will be removed`}
          </span>
          <button
            type="button"
            aria-label={t`Cancel edit`}
            data-testid="rewind-chip-cancel"
            onClick={onCancelRewind}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ) : null}
      {attachmentNotice ? (
        <div className="mb-3 rounded-card border border-warning/40 bg-warning/10 px-4 py-2 text-meta text-warning">
          {attachmentNotice}
        </div>
      ) : null}
      {mentionPickerOpen ? (
        <div
          id={mentionListboxId}
          role="listbox"
          aria-label={t`Mentions`}
          data-testid="mention-picker"
          className="mb-2 overflow-hidden rounded-card border border-border bg-muted"
        >
          {mentionOptions.map((mention, index) => {
            const optionId = `${mentionListboxId}-option-${index}`;
            const highlighted = index === activeMentionIndex;
            return (
              <button
                id={optionId}
                key={mentionChipKey(mention)}
                type="button"
                role="option"
                aria-selected={highlighted}
                aria-label={t`@${mention.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(mention)}
                onMouseEnter={() => setMentionHighlightIndex(index)}
                className={`flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent ${
                  highlighted ? "bg-accent" : ""
                }`}
              >
                <MentionOptionIcon mention={mention} />
                <span className="min-w-0">
                  <span dir="auto" className="block text-capsule text-foreground">
                    @{mention.name}
                  </span>
                  {mention.subtitle ? (
                    <span dir="auto" className="block truncate text-label text-muted-foreground">
                      {mention.subtitle}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {showSlashPicker ? (
        <div
          data-testid="slash-picker"
          className="mb-2 overflow-hidden rounded-card border border-border bg-muted"
        >
          {slashSkillOptions.map((skill) => (
            <button
              key={skill.id}
              type="button"
              aria-label={t`Skill ${skill.name}`}
              onClick={() => insertSkill(skill)}
              className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent"
            >
              <Box size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span dir="auto" className="block text-capsule text-foreground">
                  {skill.name}
                </span>
                <span dir="auto" className="block truncate text-label text-muted-foreground">
                  {truncateSlashDescription(skill.description)}
                </span>
              </span>
            </button>
          ))}
          {slashActionOptions.map((action) => {
            const label = slashActionLabel(action.id);
            return (
              <button
                key={action.id}
                type="button"
                aria-label={label}
                onClick={() => runSlashAction(action.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
              >
                <Settings size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
                <span className="text-capsule text-foreground">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <ComposerShell
        ref={shellRef}
        data-testid="composer-bar"
        state={composerState}
        attachments={
          (rewindArtifacts?.length ?? 0) > 0 || pendingAttachments.length > 0 ? (
            <>
              {rewindArtifacts?.map((artifact) => (
                <ComposerAttachment
                  key={artifact.id}
                  name={artifact.name}
                  removeLabel={t`Remove ${artifact.name}`}
                  onRemove={() => onRemoveRewindArtifact?.(artifact.id)}
                  disabled={isDictating}
                />
              ))}
              {pendingAttachments.map((attachment) => (
                <ComposerAttachment
                  key={attachment.id}
                  name={attachment.file.name}
                  previewUrl={attachment.previewUrl}
                  removeLabel={t`Remove ${attachment.file.name}`}
                  onRemove={() => onRemoveAttachment(attachment)}
                  disabled={isDictating}
                />
              ))}
            </>
          ) : undefined
        }
        attach={
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={(event) => void onAttachmentPick(event.target.files)}
            />
            <Button
              variant="roundIcon"
              size="roundIcon"
              aria-label={t`Attach file`}
              disabled={disabled || isDictating}
              onClick={() => fileInputRef.current?.click()}
              className="hover:bg-secondary"
            >
              <Plus size={17} strokeWidth={1.8} />
            </Button>
          </>
        }
        leading={
          selectedSkill || selectedMentions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedSkill ? (
                <span
                  data-testid="skill-chip"
                  className="inline-flex h-7.5 max-w-full items-center gap-1.5 rounded-full bg-accent ps-2.5 pe-2.5 text-capsule text-foreground"
                >
                  <Box size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />
                  <span dir="auto" className="truncate">
                    {selectedSkill.name}
                  </span>
                  <button
                    type="button"
                    aria-label={t`Remove skill ${selectedSkill.name}`}
                    onClick={() => setSelectedSkill(null)}
                    disabled={isDictating}
                    className="text-muted-foreground hover:text-foreground disabled:pointer-events-none"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </span>
              ) : null}
              {selectedMentions.map((mention) => (
                <span
                  key={mentionChipKey(mention)}
                  data-testid="mention-chip"
                  data-mention-kind={mention.kind}
                  className="inline-flex h-7.5 max-w-full items-center gap-1.5 rounded-full bg-chat-user ps-1.25 pe-2.5 text-capsule text-chat-user-foreground"
                >
                  <MentionChipIcon mention={mention} />
                  <span dir="auto" className="truncate">
                    {mention.name}
                  </span>
                  <button
                    type="button"
                    aria-label={t`Remove mention ${mention.name}`}
                    onClick={() =>
                      setSelectedMentions((current) =>
                        current.filter(
                          (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                        ),
                      )
                    }
                    disabled={isDictating}
                    className="text-muted-foreground hover:text-foreground disabled:pointer-events-none"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          ) : undefined
        }
        trailing={
          isDictating ? undefined : (
            <>
              {dictationAvailable ? (
                <Button
                  variant="roundIcon"
                  size="roundIcon"
                  aria-label={t`Dictate`}
                  disabled={disabled}
                  onClick={startDictation}
                  className="hover:bg-secondary"
                >
                  <Mic size={17} strokeWidth={1.8} />
                </Button>
              ) : null}
              {canSend ? (
                <Button
                  variant="roundIcon"
                  size="roundIcon"
                  aria-label={t`Send`}
                  disabled={sending || disabled}
                  onClick={send}
                  className="group/send animate-pivot bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground hover:opacity-85"
                >
                  <ArrowUp
                    size={16}
                    strokeWidth={2}
                    className="transition-transform duration-(--duration-hover) ease-quiet motion-safe:group-hover/send:-translate-y-px"
                  />
                </Button>
              ) : null}
              {running ? (
                <Button
                  variant="roundIcon"
                  size="roundIcon"
                  aria-label={t`Stop`}
                  disabled={sending}
                  onClick={() => void onStop()}
                  className="hover:bg-transparent"
                >
                  <StopContour color={botColor} />
                </Button>
              ) : null}
            </>
          )
        }
        dictationCancel={
          isDictating ? (
            <Button
              variant="roundIcon"
              size="roundIcon"
              aria-label={t`Cancel dictation`}
              onClick={cancelDictation}
              className="hover:bg-secondary"
            >
              <X size={16} strokeWidth={2.2} />
            </Button>
          ) : undefined
        }
        dictationConfirm={
          isDictating ? (
            <>
              <Button
                variant="roundIcon"
                size="roundIcon"
                aria-label={t`Insert dictation`}
                disabled={dictateFinishing}
                onClick={() => void insertDictation()}
                className="bg-primary text-primary-foreground hover:bg-primary hover:opacity-85"
              >
                <Check size={16} strokeWidth={2.4} />
              </Button>
              {running ? (
                <Button
                  variant="roundIcon"
                  size="roundIcon"
                  aria-label={t`Stop`}
                  disabled={sending}
                  onClick={() => void onStop()}
                  className="hover:bg-transparent"
                >
                  <StopContour color={botColor} />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        <span role="status" aria-live="polite" className="sr-only">
          {isDictating ? t`Dictating` : ""}
        </span>
        {isDictating ? (
          // biome-ignore lint/a11y/useSemanticElements: a real <textarea> can't style per-word ranges (blur-in words, a muted interim tail); this read-only preview replaces it only while dictating.
          <div
            ref={dictationPreviewRef}
            role="textbox"
            aria-readonly="true"
            aria-multiline="true"
            aria-label={activeName ? t`Message ${activeName}` : t`Message`}
            tabIndex={-1}
            dir="auto"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void insertDictation();
              }
            }}
            className="rk-scroll block max-h-composer-field min-h-6 w-full overflow-y-auto py-0.5 text-body text-foreground outline-none"
          >
            {(() => {
              const snapshot = dictateSnapshotRef.current;
              const prefix = snapshot?.draft ?? "";
              // Append-only: each word's index mounts once and keeps its DOM
              // node, so only a newly dictated word (a fresh index) plays the
              // blur-in entrance below — earlier ones don't replay it.
              const words = dictateSpeech.committed.split(/\s+/).filter(Boolean);
              return (
                <>
                  {prefix ? <span>{prefix} </span> : null}
                  {words.map((word, index) => (
                    <span key={index} className="rk-word-in">
                      {word}{" "}
                    </span>
                  ))}
                  {dictateSpeech.interim ? (
                    <span key="interim" className="rk-word-in text-muted-foreground">
                      {dictateSpeech.interim}
                    </span>
                  ) : null}
                </>
              );
            })()}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => updateDraft(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (
                event.key === "Backspace" &&
                draft.length === 0 &&
                (selectedSkill !== null || selectedMentions.length > 0)
              ) {
                event.preventDefault();
                removeLastChip();
                return;
              }
              if (event.key === "Escape" && !mentionPickerOpen && rewindTarget) {
                event.preventDefault();
                onCancelRewind?.();
                return;
              }
              const action = resolveMentionPickerKey({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
                optionCount: mentionOptions.length,
                highlightedIndex: activeMentionIndex,
              });
              if (action.type === "complete") {
                const mention = mentionOptions[action.index];
                if (!mention) return;
                event.preventDefault();
                insertMention(mention);
                return;
              }
              if (action.type === "move") {
                event.preventDefault();
                setMentionHighlightIndex(action.index);
                return;
              }
              if (action.type === "dismiss") {
                event.preventDefault();
                setMentionQuery(null);
                setMentionHighlightIndex(0);
                return;
              }
              if (action.type === "send") {
                event.preventDefault();
                send();
              }
            }}
            disabled={disabled}
            placeholder={
              showComposerPlaceholder
                ? activeName
                  ? t`Message ${activeName}`
                  : t`Message…`
                : undefined
            }
            aria-label={activeName ? t`Message ${activeName}` : t`Message`}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={mentionPickerOpen}
            aria-controls={mentionPickerOpen ? mentionListboxId : undefined}
            aria-activedescendant={activeMentionOptionId}
            name="chat-message"
            autoComplete="off"
            dir="auto"
            rows={1}
            className="rk-scroll block max-h-composer-field min-h-6 w-full resize-none overflow-y-auto bg-transparent py-0.5 text-body text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-40"
          />
        )}
      </ComposerShell>
    </fieldset>
  );
});

function slashActionLabel(id: SlashActionId) {
  switch (id) {
    case "chat-settings":
      return t`Chat Settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />;
  }
  if (mention.kind === "group") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        G
      </span>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        @
      </span>
    );
  }
  return (
    <BotAvatar
      color={mention.color ?? FALLBACK_BOT_COLOR}
      identity={mention.id}
      shapeSeed={mention.shapeSeed}
      size={16}
    />
  );
}

/** The 18 px avatar sized for the Quiet mention chip (see docs/design-system.md). */
function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  if (mention.kind === "routine") {
    return <Clock size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "connector") {
    return <Puzzle size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />;
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent text-[9px] text-foreground/75">
        {mention.kind === "group" ? "G" : "@"}
      </span>
    );
  }
  return (
    <BotAvatar
      color={mention.color ?? FALLBACK_BOT_COLOR}
      identity={mention.id}
      shapeSeed={mention.shapeSeed}
      size={18}
    />
  );
}
