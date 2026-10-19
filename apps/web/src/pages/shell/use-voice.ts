import type { VoiceStatus } from "@rakazo/contracts";
import type { ThreadView } from "@rakazo/core";
import { speechFromBlocks } from "@rakazo/core";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import type { ThreadState } from "../../lib/thread-events";
import type { MessageItem } from "../../lib/thread-items";
import { botIdOf } from "../../lib/thread-items";
import { speaker } from "../../lib/tts";
import type { Panel } from "./layout";
import type { Roster } from "./use-roster";
import { isWorking } from "./use-thread-view";

/** Bound Settings leave so a hung voice status refresh cannot block dismissal. */
const VOICE_STATUS_REFRESH_TIMEOUT_MS = 10_000;

function voiceStatusRefreshTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    AbortSignal.timeout(VOICE_STATUS_REFRESH_TIMEOUT_MS).addEventListener("abort", () => {
      reject(new DOMException("Voice status refresh timed out", "TimeoutError"));
    });
  });
}

/** The bot's voice: readiness, the call view, and reading replies aloud. */
export function useVoice({
  roster,
  snapshot,
  view,
  setPanel,
}: {
  roster: Roster;
  snapshot: ThreadState | null;
  view: ThreadView;
  setPanel: Dispatch<SetStateAction<Panel>>;
}) {
  const { active, activeBotId } = roster;
  const [callOpen, setCallOpen] = useState(false);
  const voiceButtonRef = useRef<HTMLButtonElement>(null);
  const wasCallOpen = useRef(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

  useEffect(() => {
    void rpc.voice
      .status()
      .then(setVoiceStatus)
      .catch(() => undefined);
    const unsubSpeech = speaker.subscribe((state) => {
      setSpeakingMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    return () => {
      unsubSpeech();
    };
  }, []);

  // A call is bound to one bot; switching bots mid-call would otherwise
  // silently re-target the mic and speaker at the new one instead of ending it.
  useEffect(() => {
    setCallOpen(false);
  }, [active?.id]);

  // The call view sits above the side panel (z-20 inside main vs. the panel's
  // z-30), so an open panel would otherwise paint over Mute/End call. Closing
  // it here also makes the header button that opens it inert along with the
  // rest of the conversation column while the call is up.
  useEffect(() => {
    if (callOpen) setPanel(null);
  }, [callOpen]);

  // Returns focus to the button that opened the call once it closes; it
  // opens the call view itself, which focuses its own root.
  useEffect(() => {
    if (wasCallOpen.current && !callOpen) {
      voiceButtonRef.current?.focus();
    }
    wasCallOpen.current = callOpen;
  }, [callOpen]);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const lastBot = view.rows.findLast(
      (row): row is typeof row & { item: MessageItem } =>
        row.item.kind === "message" && row.item.role === "bot",
    )?.item;
    if (autoSpokenBotId.current !== active.id) {
      autoSpokenBotId.current = active.id;
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (callOpen || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (isWorking(snapshot.run, view)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    void speaker.speak(text, { botId: active.id, messageId: lastBot.id });
  }, [view, snapshot?.run, snapshot?.botId, active?.autoSpeak, active?.id, callOpen]);

  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const speakMessage = useCallback((message: MessageItem) => {
    if (speakingMessageIdRef.current === message.id) {
      speaker.stop();
      return;
    }
    const text = speechFromBlocks(message.blocks);
    const id = botIdOf(message) ?? activeBotId.current;
    if (text && id) void speaker.speak(text, { botId: id, messageId: message.id });
  }, []);

  async function refreshVoiceStatus() {
    try {
      setVoiceStatus(await Promise.race([rpc.voice.status(), voiceStatusRefreshTimeout()]));
    } catch {
      // Prefer reopening Voice settings over CallView with stale readiness.
      setVoiceStatus(null);
    }
  }

  return {
    callOpen,
    setCallOpen,
    voiceButtonRef,
    voiceStatus,
    refreshVoiceStatus,
    speakingMessageId,
    speakMessage,
  };
}

export type Voice = ReturnType<typeof useVoice>;
