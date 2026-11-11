import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@tangow/contracts";
import type { ComposerMention } from "@tangow/core";
import { Button } from "@tangow/ui-web";
import { Check, Mic, X } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { desktopBridge } from "../../lib/desktop.js";
import { dictation, webSpeechAvailable } from "../../lib/dictation.js";

/** The composer's mic: speech turns into text in the field, nothing is ever sent on its own. */
export function useComposerDictation({
  disabled,
  dictationTranscribe,
  recentWriting,
  draft,
  setDraft,
  selectedMentions,
  setSelectedMentions,
  selectedSkill,
  setSelectedSkill,
  textareaRef,
  onStart,
}: {
  disabled?: boolean;
  dictationTranscribe?: boolean;
  recentWriting?: () => readonly string[];
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  selectedMentions: ComposerMention[];
  setSelectedMentions: Dispatch<SetStateAction<ComposerMention[]>>;
  selectedSkill: AgentSkillCatalogEntry | null;
  setSelectedSkill: Dispatch<SetStateAction<AgentSkillCatalogEntry | null>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Closes the pickers as dictation takes over the field. */
  onStart: () => void;
}) {
  // `dictateSnapshotRef` freezes the draft/chips at the tap so × can restore
  // them exactly; `isDictatingRef` mirrors `isDictating` so the
  // `dictation.subscribe` effect below (mounted once) always reads the latest
  // without resubscribing on every render.
  const [isDictating, setIsDictating] = useState(false);
  const isDictatingRef = useRef(false);
  isDictatingRef.current = isDictating;
  const [dictateSpeech, setDictateSpeech] = useState({ committed: "", interim: "" });
  // Why the last dictation session ended on its own (mic denied, engine or
  // transcription failure), shown in the composer's error banner.
  const [dictationError, setDictationError] = useState<string | null>(null);
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
  const dictateFinishCancelledRef = useRef(false);
  // Set only by ×: every other way dictation ends (an engine error, a call
  // cutting it off) keeps what was dictated rather than restoring the
  // pre-dictation draft.
  const dictateUserCancelRef = useRef(false);
  const speechAvailable = useMemo(() => webSpeechAvailable(), []);
  const dictationAvailable = speechAvailable || Boolean(dictationTranscribe);
  // Electron's Chromium reports Web Speech as available but it usually has no
  // speech-service key configured there, so on desktop the configured voice
  // provider is tried first when it can transcribe (dictation.ts also falls
  // back to it if Web Speech then fails to start).
  const preferTranscribe = Boolean(desktopBridge()) && Boolean(dictationTranscribe);

  function exitDictation(keepDictated: boolean) {
    setIsDictating(false);
    const snapshot = dictateSnapshotRef.current;
    const wasActive = snapshot !== null;
    dictateSnapshotRef.current = null;
    if (snapshot) {
      const last = dictateLastSpeechRef.current;
      const dictated = keepDictated
        ? [last.transcript, last.interim].filter(Boolean).join(" ")
        : "";
      setDraft([snapshot.draft, dictated].filter(Boolean).join(" "));
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
  // all funnel through here: × restores the pre-dictation draft, anything
  // else keeps the dictated text and surfaces the engine's error, if any.
  // `insertDictation` is the one path
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
      if (dictateInsertingRef.current || !dictateSnapshotRef.current) return;
      if (snapshot.error) setDictationError(snapshot.error);
      exitDictation(!dictateUserCancelRef.current);
    });
    return () => {
      unsubscribe();
      if (isDictatingRef.current) dictation.stop("cancel");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isDictating) return;
    // Auto-stops end dictation like ✓ (keeping what was said, including the
    // recorder's pending chunk), never like ×. A ✓ already in flight is a
    // bounded wait, not idle listening — leave it alone.
    function stopIfHidden() {
      if (dictateInsertingRef.current) return;
      if (document.hidden) void insertDictation();
    }
    const interval = setInterval(() => {
      if (dictateInsertingRef.current) return;
      const now = Date.now();
      const silentTooLong = now - dictateActivityRef.current > 60_000;
      const sessionTooLong = now - dictateStartedRef.current > 5 * 60_000;
      if (silentTooLong || sessionTooLong) void insertDictation();
    }, 2_000);
    document.addEventListener("visibilitychange", stopIfHidden);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", stopIfHidden);
    };
  }, [isDictating]);

  function startDictation() {
    if (disabled || isDictating || !dictationAvailable) return;
    onStart();
    setDictationError(null);
    dictateSnapshotRef.current = { draft, mentions: selectedMentions, skill: selectedSkill };
    setDictateSpeech({ committed: "", interim: "" });
    dictateLastSpeechRef.current = { transcript: "", interim: "" };
    dictateActivityRef.current = Date.now();
    dictateStartedRef.current = Date.now();
    dictateUserCancelRef.current = false;
    setIsDictating(true);
    window.requestAnimationFrame(() => dictationPreviewRef.current?.focus());
    void dictation.listen({
      mode: "dictate",
      transcribe: dictationTranscribe,
      preferTranscribe,
      recentTexts: [...(recentWriting?.() ?? []), draft],
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
      exitDictation(false);
      return;
    }
    dictateUserCancelRef.current = true;
    dictation.stop("cancel");
  }

  async function insertDictation() {
    if (!isDictating || dictateInsertingRef.current) return;
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
    // Partial text (a chunk failed or timed out) is kept, with the error shown.
    if (dictation.state.error) setDictationError(dictation.state.error);
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

  // The dictation preview keeps the newest words in view once the text
  // outgrows the field's height cap, instead of leaving them scrolled out of
  // sight below the fold.
  useEffect(() => {
    if (!isDictating) return;
    const el = dictationPreviewRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isDictating, dictateSpeech]);

  return {
    isDictating,
    dictateSpeech,
    /** The draft frozen at the tap, shown ahead of the dictated words. */
    dictatedPrefix: dictateSnapshotRef.current?.draft ?? "",
    dictateFinishing,
    dictationAvailable,
    dictationError,
    setDictationError,
    dictationPreviewRef,
    startDictation,
    cancelDictation,
    insertDictation,
  };
}

/** The read-only field shown in place of the textarea while dictating. */
export function DictationPreview({
  previewRef,
  label,
  prefix,
  speech,
  onConfirm,
}: {
  previewRef: RefObject<HTMLDivElement | null>;
  label: string;
  prefix: string;
  speech: { committed: string; interim: string };
  onConfirm: () => void;
}) {
  // Append-only: each word's index mounts once and keeps its DOM
  // node, so only a newly dictated word (a fresh index) plays the
  // blur-in entrance below — earlier ones don't replay it.
  const words = speech.committed.split(/\s+/).filter(Boolean);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a real <textarea> can't style per-word ranges (blur-in words, a muted interim tail); this read-only preview replaces it only while dictating.
    <div
      ref={previewRef}
      role="textbox"
      aria-readonly="true"
      aria-multiline="true"
      aria-label={label}
      tabIndex={-1}
      dir="auto"
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onConfirm();
        }
      }}
      className="rk-scroll block max-h-composer-field min-h-6 w-full overflow-y-auto py-1 text-body text-foreground outline-none"
    >
      {prefix ? <span>{prefix} </span> : null}
      {words.map((word, index) => (
        <span key={index} className="rk-word-in">
          {word}{" "}
        </span>
      ))}
      {speech.interim ? (
        <span key="interim" className="rk-word-in text-muted-foreground">
          {speech.interim}
        </span>
      ) : null}
    </div>
  );
}

export function DictateButton({ disabled, onStart }: { disabled?: boolean; onStart: () => void }) {
  const { t } = useLingui();
  return (
    <Button
      variant="roundIcon"
      size="roundIcon"
      aria-label={t`Dictate`}
      disabled={disabled}
      onClick={onStart}
      className="hover:bg-secondary"
    >
      <Mic size={17} strokeWidth={1.8} />
    </Button>
  );
}

export function DictationCancel({ onCancel }: { onCancel: () => void }) {
  const { t } = useLingui();
  return (
    <Button
      variant="roundIcon"
      size="roundIcon"
      aria-label={t`Cancel dictation`}
      onClick={onCancel}
      className="hover:bg-secondary"
    >
      <X size={16} strokeWidth={2.2} />
    </Button>
  );
}

export function DictationConfirm({
  finishing,
  onConfirm,
}: {
  finishing: boolean;
  onConfirm: () => void;
}) {
  const { t } = useLingui();
  return (
    <Button
      variant="roundIcon"
      size="roundIcon"
      aria-label={t`Insert dictation`}
      disabled={finishing}
      onClick={onConfirm}
      className="bg-primary text-primary-foreground hover:bg-primary hover:opacity-85"
    >
      <Check size={16} strokeWidth={2.4} />
    </Button>
  );
}
