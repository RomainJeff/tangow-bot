import { writtenLanguage } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";
import {
  abortDictation,
  cancelsDictationOnAppState,
  dictationAvailable,
  startDictation,
  stopDictation,
} from "./dictation";
import { dictateHaptic, insertHaptic } from "./haptics";
import { t } from "./i18n";
import type { VolumeStore } from "./volume-store";
import { createVolumeStore } from "./volume-store";

function joinWithSeparator(snapshot: string, addition: string): string {
  if (!addition) return snapshot;
  if (!snapshot) return addition;
  return /\s$/.test(snapshot) ? `${snapshot}${addition}` : `${snapshot} ${addition}`;
}

function presentPermissionDeniedAlert() {
  Alert.alert(t("Microphone access is off"), undefined, [
    { text: t("Cancel"), style: "cancel" },
    { text: t("Open Settings"), onPress: () => void Linking.openSettings() },
  ]);
}

export interface ComposerDictationHook {
  /** The mic is only ever shown once this resolves true. */
  available: boolean;
  dictating: boolean;
  /** The still-provisional tail (`mutedForeground` until it finalizes). */
  interimText: string;
  /** The pre-dictation draft, plus its separator once there's dictated text
   * to follow it — for `DictationPreview`'s un-animated prefix. */
  previewPrefix: string;
  /** The finalized dictated text only — `DictationPreview`'s `finalText`. */
  finalText: string;
  /** The engine's current input level (`-2`..`10`), when it reports one;
   * `null` while dictating means "no level available yet" and while idle
   * means "not applicable". A store, not state: only the waveform reads it. */
  volume: VolumeStore;
  /** Tap the mic: snapshots the draft, closes the pickers, starts listening. */
  start: () => void;
  /** ✓ — keeps the composed text, exits dictation. Nothing is sent. */
  insert: () => void;
  /** × or any forced-cancel path — restores the exact pre-dictation draft. */
  cancel: () => void;
}

/**
 * Composer dictation state: owns the mic's availability check,
 * the running transcript, and every exit path (Insert, Cancel, and the
 * forced cancels — backgrounding, a thread switch, losing screen focus, or
 * unmount). The only thing it reaches into its caller for is the draft
 * itself, so `thread.tsx` stays the single owner of `draft`.
 */
export function useComposerDictation({
  draft,
  setDraft,
  threadKey,
  closePickers,
  recentWriting,
}: {
  draft: string;
  setDraft: (value: string) => void;
  /** Changes (or the hook unmounts) end an active dictation as a forced cancel. */
  threadKey: string | undefined;
  /** Closes the mention and slash pickers — both stay inert during dictation. */
  closePickers: () => void;
  /** The person's own recent messages here, to dictate in the language they write in. */
  recentWriting?: () => readonly string[];
}): ComposerDictationHook {
  const [available, setAvailable] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [volume] = useState(createVolumeStore);
  const snapshotRef = useRef("");
  const finalTextRef = useRef("");
  const dictatingRef = useRef(false);
  dictatingRef.current = dictating;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // True from the mic tap until the engine actually starts (or dictation
  // ends first). While it's true, the permission prompt itself can make
  // AppState report a transition that looks like the user leaving — see the
  // `AppState` effect below.
  const permissionPendingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void dictationAvailable().then((value) => {
      if (!cancelled) setAvailable(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const resetDictationUiState = useCallback(() => {
    permissionPendingRef.current = false;
    setDictating(false);
    setFinalText("");
    setInterimText("");
    volume.set(null);
  }, [volume]);

  const exitToSnapshot = useCallback(() => {
    resetDictationUiState();
    setDraft(snapshotRef.current);
  }, [resetDictationUiState, setDraft]);

  const cancel = useCallback(() => {
    if (!dictatingRef.current) return;
    abortDictation();
    exitToSnapshot();
  }, [exitToSnapshot]);

  const insert = useCallback(() => {
    if (!dictatingRef.current) return;
    insertHaptic();
    stopDictation();
    // The draft already holds the composed text (kept live by `onText`) —
    // just leave dictation mode, nothing is sent.
    resetDictationUiState();
  }, [resetDictationUiState]);

  const start = useCallback(() => {
    if (dictatingRef.current || !available) return;
    dictateHaptic();
    snapshotRef.current = draftRef.current;
    finalTextRef.current = "";
    closePickers();
    setFinalText("");
    setInterimText("");
    volume.set(null);
    setDictating(true);
    permissionPendingRef.current = true;
    void startDictation({
      spokenLanguage: writtenLanguage([...(recentWriting?.() ?? []), draftRef.current]),
      onStart: () => {
        permissionPendingRef.current = false;
      },
      onVolume: (value) => volume.set(value),
      onText: (text, isFinal) => {
        if (isFinal) {
          finalTextRef.current = text;
          setFinalText(text);
          setInterimText("");
        } else {
          const finalSoFar = finalTextRef.current;
          const tail =
            finalSoFar && text.startsWith(finalSoFar)
              ? text.slice(finalSoFar.length).replace(/^\s+/, "")
              : text;
          setInterimText(tail);
        }
        setDraft(joinWithSeparator(snapshotRef.current, text));
      },
      onEnd: (reason, alreadyDenied) => {
        // A caller-requested stop/abort already exited synchronously; this
        // is only reached for the caps and permission-denied paths.
        if (!dictatingRef.current) return;
        exitToSnapshot();
        // Only show the alert when permission was already denied before this
        // tap — refusing the system prompt itself just exits quietly.
        if (reason === "denied" && alreadyDenied) presentPermissionDeniedAlert();
      },
    });
  }, [available, closePickers, exitToSnapshot, setDraft, volume, recentWriting]);

  // Forced cancel: leaving the app while dictation runs (see
  // `cancelsDictationOnAppState` for why the permission prompt is ignored).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (cancelsDictationOnAppState(state, Platform.OS, permissionPendingRef.current)) cancel();
    });
    return () => subscription.remove();
  }, [cancel]);

  // Forced cancel: another screen is pushed on top of this thread (a bot
  // card, bot/group settings, …). The thread stays mounted underneath, so
  // without this the mic would keep listening into a screen the user can no
  // longer see.
  useFocusEffect(
    useCallback(() => {
      return () => cancel();
    }, [cancel]),
  );

  // A thread switch resets `draft` on its own (the effect in `thread.tsx`
  // keyed by the same `threadKey`) — restoring the old thread's snapshot
  // here would race it, so this only stops the engine and leaves dictation
  // mode, without touching `draft`.
  useEffect(() => {
    return () => {
      if (dictatingRef.current) {
        abortDictation();
        resetDictationUiState();
      }
    };
  }, [threadKey, resetDictationUiState]);

  const previewPrefix =
    snapshotRef.current && (finalText || interimText) && !/\s$/.test(snapshotRef.current)
      ? `${snapshotRef.current} `
      : snapshotRef.current;

  return {
    available,
    dictating,
    interimText,
    previewPrefix,
    finalText,
    volume,
    start,
    insert,
    cancel,
  };
}
