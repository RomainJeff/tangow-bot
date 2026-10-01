import { readBoundedResponseBytes, writtenLanguage } from "@rakazo/core";
import { selectedSpaceId, withSpaceHeaders } from "./rpc.js";

// "dictate" is the composer's continuous mode: no endpoint
// silence detection, restarts indefinitely until the caller stops it, and
// separates the finalized (`transcript`) text from the not-yet-final tail
// (`interim`) so the UI can render one in `foreground` and the other muted.
export type DictationMode = "hold" | "endpoint" | "dictate";

export type DictationSnapshot = {
  status: "idle" | "listening" | "transcribing";
  transcript: string;
  /** "dictate" mode only: the tail Web Speech hasn't finalized yet. */
  interim?: string;
  error?: string;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const IDLE: DictationSnapshot = { status: "idle", transcript: "" };
const ENDPOINT_TICK_MS = 80;
const SILENCE_RMS = 0.035;
export const TRANSCRIPTION_RESPONSE_TIMEOUT_MS = 70_000;
export const MAX_TRANSCRIPTION_RESPONSE_BYTES = 64 * 1024;
const ENDPOINT_UNSUPPORTED =
  "This browser can't detect when you stop talking. Use Chrome, the desktop app, or hold-to-talk in the composer.";

export function webSpeechAvailable(): boolean {
  return Boolean(speechRecognitionCtor());
}

/** The locale a language's speech model is usually published under. */
const USUAL_SPEECH_LOCALE: Record<string, string> = {
  en: "en-US",
  fr: "fr-FR",
  es: "es-ES",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-BR",
};

/**
 * `SpeechRecognition.lang` for the person's own recent writing, same
 * heuristic as the mobile app (`writtenLanguage`, `@rakazo/core`): the
 * browser's own language is not necessarily the one they write in (a
 * browser set to English still reports English to someone writing in
 * French). A clear language wins, as a locale the recognizer knows: one of
 * the browser's own preferred locales in that language, else the
 * language's usual locale. Gluing the language to the browser's region
 * gave locales such as `fr-US`, which the engine refuses at once, so
 * dictation closed as soon as it opened. With no clear language, the
 * browser's own locale is used as is.
 */
export function dictationLangFor(
  recentTexts: readonly string[],
  browserLanguage: string,
  browserLanguages: readonly string[] = [],
): string {
  const fallback = browserLanguage || "en-US";
  const language = writtenLanguage(recentTexts);
  if (!language) return fallback;
  const primary = (locale: string) => locale.replace(/_/g, "-").split("-")[0]?.toLowerCase();
  if (primary(fallback) === language) return fallback;
  const preferred = browserLanguages.find(
    (locale) => primary(locale) === language && locale.includes("-"),
  );
  return preferred ?? USUAL_SPEECH_LOCALE[language] ?? language;
}

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

function audioContextCtor(): (new () => AudioContext) | undefined {
  if (typeof AudioContext === "function") return AudioContext;
  if (typeof window === "undefined") return undefined;
  const host = window as Window & { webkitAudioContext?: typeof AudioContext };
  return host.webkitAudioContext;
}

export class Dictation {
  private snapshot: DictationSnapshot = IDLE;
  private watchers = new Set<(s: DictationSnapshot) => void>();
  private recognition: SpeechRecognitionLike | null = null;
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private token = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Every in-flight transcription request, so `stop("cancel")` can abort
   * them at once. */
  private activeAborts = new Set<AbortController>();
  private audioContext: AudioContext | null = null;
  private vadTimer: ReturnType<typeof setInterval> | undefined;
  private onFinal: ((text: string) => void) | null = null;
  /** "dictate" mode: text finalized by a previous Web Speech instance, kept
   * across the restarts continuous listening goes through (each restart's
   * `SpeechRecognition` starts its own `results` from empty). Also the
   * recorder fallback's running transcript, appended to as each chunk's
   * transcription resolves. */
  private dictateCommitted = "";
  /** The live mic stream, shared by both recorder paths (hold/endpoint's
   * single recording, and the dictate chunk loop's one `getUserMedia` call
   * for the whole session). `stop()` always releases its tracks itself,
   * regardless of whether a `MediaRecorder`'s own `onstop` runs — that's what
   * keeps a cancel from ever leaving the mic captured. */
  private stream: MediaStream | null = null;
  private dictateChunkTimer: ReturnType<typeof setTimeout> | undefined;
  /** Recorder fallback only: chains each chunk's transcription, one request
   * at a time, so results are appended in recording order. */
  private dictateChain: Promise<void> = Promise.resolve();
  /** Recorder fallback only: set while ✓ is waiting on the last chunk — stops
   * the loop from starting another chunk once the current one ends. */
  private dictateFinishing = false;
  /** Resolves `finishDictate()`'s wait on the recorder's stop event, so a
   * `stop()` landing in that window (a cancel racing ✓) still settles the
   * promise instead of leaving it pending forever. */
  private pendingFinish: (() => void) | null = null;

  subscribe(fn: (s: DictationSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  get state(): DictationSnapshot {
    return this.snapshot;
  }

  private set(next: DictationSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  stop(reason: "submit" | "cancel" | "replace" = "cancel") {
    this.token += 1;
    for (const abort of this.activeAborts) abort.abort();
    this.activeAborts.clear();
    this.stopVad();
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    clearTimeout(this.dictateChunkTimer);
    this.dictateChunkTimer = undefined;
    this.dictateChain = Promise.resolve();
    this.dictateFinishing = false;
    // Unblocks a `finishDictate()` that's waiting on this chunk's stop event —
    // otherwise a cancel landing in that window leaves it pending forever.
    const resolveFinish = this.pendingFinish;
    this.pendingFinish = null;
    resolveFinish?.();
    const rec = this.recognition;
    this.recognition = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        if (reason === "submit") rec.stop();
        else rec.abort();
      } catch {
        // already stopped
      }
    }
    const media = this.media;
    this.media = null;
    if (media) {
      // A cancel must drop whatever this chunk has captured so far, not
      // transcribe it — clear the handlers before stopping.
      media.ondataavailable = null;
      media.onstop = null;
      if (media.state !== "inactive") {
        try {
          media.stop();
        } catch {
          // already stopped
        }
      }
    }
    // Release the mic itself here, unconditionally — a recorder path's own
    // `onstop` only runs on a natural completion (its handlers are just
    // nulled above on a cancel), so this is the one place both recorder
    // paths are guaranteed to give the tracks back.
    const stream = this.stream;
    this.stream = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    this.chunks = [];
    this.onFinal = null;
    this.dictateCommitted = "";
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  async listen(opts: {
    mode: DictationMode;
    transcribe?: boolean;
    /**
     * Skip Web Speech even when the browser exposes it, and go straight to
     * the configured provider. Electron's Chromium reports
     * `webkitSpeechRecognition` as available but usually has no speech
     * service key configured, so on desktop the provider (when it can
     * transcribe) is tried first instead of failing on `network`.
     */
    preferTranscribe?: boolean;
    endpointMs?: number;
    /** The person's own recent messages (+ their in-progress draft), to
     * dictate in the language they write in rather than the browser's own
     * language (see `dictationLangFor`). */
    recentTexts?: readonly string[];
    onFinal: (text: string) => void;
  }): Promise<void> {
    this.stop("replace");
    const mine = this.token;
    const spaceId = selectedSpaceId();
    this.onFinal = opts.onFinal;
    this.set({ status: "listening", transcript: "" });
    if (webSpeechAvailable() && !(opts.preferTranscribe && opts.transcribe)) {
      this.listenWebSpeech(
        opts.mode,
        opts.endpointMs ?? 850,
        mine,
        Boolean(opts.transcribe),
        spaceId,
        opts.recentTexts ?? [],
      );
      return;
    }
    if (opts.mode === "dictate") {
      if (opts.transcribe) {
        await this.listenDictateRecorder(mine, spaceId);
        return;
      }
      this.set({
        ...IDLE,
        error:
          "This browser has no on-device dictation. Connect a voice provider with transcription, or use Chrome / the desktop app.",
      });
      return;
    }
    if (opts.transcribe) {
      await this.listenRecorder(mine, opts.mode, opts.endpointMs ?? 850, spaceId);
      return;
    }
    this.set({
      ...IDLE,
      error:
        "This browser has no on-device dictation. Connect a voice provider with transcription, or use Chrome / the desktop app.",
    });
  }

  private listenWebSpeech(
    mode: DictationMode,
    endpointMs: number,
    mine: number,
    transcribeFallback: boolean,
    spaceId: string | null,
    recentTexts: readonly string[],
  ) {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = dictationLangFor(
      recentTexts,
      navigator.language || "en-US",
      navigator.languages ?? [],
    );
    rec.onresult = (event) => {
      if (this.token !== mine) return;
      if (mode === "dictate") {
        let curFinal = "";
        let curInterim = "";
        for (let i = 0; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = (result?.[0]?.transcript ?? "").trim();
          if (!text) continue;
          if (result?.isFinal) curFinal = curFinal ? `${curFinal} ${text}` : text;
          else curInterim = curInterim ? `${curInterim} ${text}` : text;
        }
        const committed = this.dictateCommitted
          ? curFinal
            ? `${this.dictateCommitted} ${curFinal}`
            : this.dictateCommitted
          : curFinal;
        this.set({ status: "listening", transcript: committed, interim: curInterim });
        return;
      }
      let transcript = "";
      for (let i = 0; i < event.results.length; i += 1) {
        transcript += event.results[i]?.[0]?.transcript ?? "";
      }
      this.set({ status: "listening", transcript: transcript.trim() });
      if (mode !== "endpoint") return;
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        if (this.token !== mine) return;
        const text = this.snapshot.transcript.trim();
        this.finish(text, mine);
      }, endpointMs);
    };
    rec.onerror = (event) => {
      if (this.token !== mine) return;
      if (event.error === "aborted" || event.error === "no-speech") return;
      if (
        transcribeFallback &&
        (event.error === "network" || event.error === "service-not-allowed") &&
        this.snapshot.status !== "idle" &&
        !this.snapshot.transcript &&
        !this.snapshot.interim
      ) {
        // Web Speech reported itself available but can't actually run here
        // (Electron's Chromium usually has no speech-service key) — fall
        // back to the configured provider instead of failing outright.
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        this.recognition = null;
        if (mode === "dictate") void this.listenDictateRecorder(mine, spaceId);
        else void this.listenRecorder(mine, mode, endpointMs, spaceId);
        return;
      }
      this.set({
        ...IDLE,
        error: event.error ? `Dictation failed: ${event.error}` : "Dictation failed.",
      });
    };
    rec.onend = () => {
      if (this.token !== mine) return;
      if (this.snapshot.status !== "listening") return;
      if (mode === "dictate") {
        // A natural end (iOS Web Speech stops after ~3s of silence) must not
        // exit dictation — only ✓, ×, or a forced cancel do. Persist what
        // this instance finalized, then keep listening on a fresh instance;
        // its own interim tail is gone along with it.
        this.dictateCommitted = this.snapshot.transcript;
        this.set({ status: "listening", transcript: this.dictateCommitted, interim: "" });
        try {
          rec.start();
        } catch {
          this.set({ ...IDLE, error: "Dictation ended unexpectedly." });
        }
        return;
      }
      if (mode === "hold") {
        this.finish(this.snapshot.transcript, mine);
        return;
      }
      const text = this.snapshot.transcript.trim();
      if (text) {
        this.finish(text, mine);
        return;
      }
      try {
        rec.start();
      } catch {
        this.set({ ...IDLE, error: "Dictation ended unexpectedly." });
      }
    };
    this.recognition = rec;
    rec.start();
  }

  private async listenRecorder(
    mine: number,
    mode: DictationMode,
    endpointMs: number,
    spaceId: string | null,
  ) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (this.token !== mine) return;
      this.set({
        ...IDLE,
        error: error instanceof Error ? error.message : "Microphone failed",
      });
      return;
    }
    if (this.token !== mine) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    if (mode === "endpoint" && !this.armSilence(stream, mine, endpointMs)) {
      for (const track of stream.getTracks()) track.stop();
      this.set({ ...IDLE, error: ENDPOINT_UNSUPPORTED });
      return;
    }
    this.stream = stream;
    const media = new MediaRecorder(stream);
    this.media = media;
    this.chunks = [];
    media.ondataavailable = (event) => {
      if (this.token !== mine) return;
      if (event.data.size) this.chunks.push(event.data);
    };
    media.onstop = () => {
      // A natural completion (VAD / submitHold stopping the recorder
      // directly): release the mic right away, and mark it released so
      // `stop()`'s own cleanup (reached via `finish()` below) doesn't try
      // to stop the same tracks again.
      if (this.stream === stream) this.stream = null;
      for (const track of stream.getTracks()) track.stop();
      if (this.token !== mine) return;
      this.stopVad();
      void this.transcribeChunks(mine, spaceId);
    };
    media.start(mode === "endpoint" ? 250 : undefined);
  }

  /**
   * "dictate" mode without Web Speech (Electron, or a browser without it):
   * there is no streaming transcription API to react to, so continuous
   * listening is approximated by recording fixed-length chunks and
   * transcribing each one through the configured voice provider. One
   * `getUserMedia` call covers the whole session (`this.stream`); at each
   * chunk boundary a fresh `MediaRecorder` starts on that same stream
   * *before* the finished chunk's transcription is awaited, so nothing
   * spoken while a request is in flight is lost. `dictateChain` transcribes
   * the chunks one at a time, in recording order.
   * No interim tail in this path — a chunk's text only appears once its
   * request returns. A chunk that fails to transcribe (5xx, 429, 401, a
   * timeout, a network error) ends the whole session instead of silently
   * dropping the result and looping forever.
   */
  private async listenDictateRecorder(mine: number, spaceId: string | null) {
    const CHUNK_MS = 4_000;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (this.token !== mine) return;
      this.set({ ...IDLE, error: error instanceof Error ? error.message : "Microphone failed" });
      return;
    }
    if (this.token !== mine) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;

    const appendResult = async (blob: Blob) => {
      if (this.token !== mine || !blob.size) return;
      const result = await this.transcribeBlob(blob, spaceId, mine);
      if (this.token !== mine) return;
      if (!result.ok) {
        // While ✓ waits for the last chunks the recorder is already stopping:
        // keep what was transcribed so far rather than wiping it.
        if (this.dictateFinishing) return;
        // Stop the recorder loop, release the mic, and abort any other
        // in-flight chunk — a failed chunk must end the session, not keep
        // recording and uploading with no way for the UI to know.
        const error = this.snapshot.error;
        this.stop("cancel");
        this.set({ ...IDLE, error });
        return;
      }
      if (!result.text) return;
      this.dictateCommitted = this.dictateCommitted
        ? `${this.dictateCommitted} ${result.text}`
        : result.text;
      // Keep whatever status the session is currently in (still listening,
      // or "transcribing" while ✓ waits on the last chunk) so a chunk that
      // lands during the finishing wait still shows up in order.
      if (this.snapshot.status !== "idle") {
        this.set({ status: this.snapshot.status, transcript: this.dictateCommitted });
      }
    };

    const recordNext = () => {
      if (this.token !== mine || this.dictateFinishing) return;
      const media = new MediaRecorder(stream);
      this.media = media;
      let chunks: Blob[] = [];
      media.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      media.onstop = () => {
        if (this.media === media) this.media = null;
        const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
        chunks = [];
        this.dictateChain = this.dictateChain.then(() => appendResult(blob));
        if (this.token === mine && !this.dictateFinishing) recordNext();
      };
      media.start();
      this.dictateChunkTimer = setTimeout(() => {
        if (media.state === "inactive") return;
        try {
          media.stop();
        } catch {
          // already stopped
        }
      }, CHUNK_MS);
    };
    recordNext();
  }

  /**
   * ✓ on the recorder fallback: stop the current chunk's recorder gracefully
   * (its audio still gets transcribed and appended, not dropped like a
   * cancel would), then wait for it and any earlier chunk still in flight,
   * bounded by the same timeout a single transcription request gets. On Web
   * Speech there is nothing to wait for — the text is already live in
   * `snapshot`. The wait below never hangs: a `stop()` landing before the
   * recorder's own stop event (× racing ✓) resolves it directly through
   * `pendingFinish`, and a timeout covers any other stall. When a chunk
   * failed or the wait timed out, the text kept so far is returned and the
   * snapshot is left with the error, so the caller can say it's partial.
   */
  async finishDictate(): Promise<string> {
    const mine = this.token;
    if (this.recognition) {
      const text = [this.snapshot.transcript, this.snapshot.interim ?? ""]
        .filter(Boolean)
        .join(" ")
        .trim();
      this.stop("submit");
      return text;
    }
    const media = this.media;
    if (!media) {
      const text = this.dictateCommitted.trim();
      this.stop("submit");
      return text;
    }
    this.dictateFinishing = true;
    clearTimeout(this.dictateChunkTimer);
    this.dictateChunkTimer = undefined;
    this.set({ status: "transcribing", transcript: this.dictateCommitted });
    await new Promise<void>((resolve) => {
      let settled = false;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        if (this.pendingFinish === finish) this.pendingFinish = null;
        resolve();
      };
      this.pendingFinish = finish;
      fallback = setTimeout(finish, TRANSCRIPTION_RESPONSE_TIMEOUT_MS);
      const previousOnStop = media.onstop;
      media.onstop = (event) => {
        previousOnStop?.call(media, event);
        finish();
      };
      // Already inactive: the chunk timer stopped it and its stop event is
      // still on its way. Wait for it, so that chunk is transcribed too.
      if (media.state === "inactive") return;
      try {
        media.stop();
      } catch {
        finish();
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      this.dictateChain.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), TRANSCRIPTION_RESPONSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    const text = this.dictateCommitted.trim();
    if (this.token !== mine) return text;
    // A failed chunk already set its error (and left the snapshot idle).
    const error = timedOut ? "Transcription request timed out." : this.snapshot.error;
    this.stop("submit");
    if (error) this.set({ ...IDLE, error });
    return text;
  }

  private armSilence(stream: MediaStream, mine: number, endpointMs: number): boolean {
    const Ctor = audioContextCtor();
    if (!Ctor) return false;
    try {
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      this.audioContext = ctx;
      if (ctx.state === "suspended") void ctx.resume();
      const data = new Uint8Array(analyser.fftSize);
      let heardSpeech = false;
      let silentFor = 0;
      this.vadTimer = setInterval(() => {
        const media = this.media;
        if (this.token !== mine || !media || media.state === "inactive") return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const sample of data) {
          const n = (sample - 128) / 128;
          sum += n * n;
        }
        const rms = Math.sqrt(sum / data.length);
        if (rms > SILENCE_RMS) {
          heardSpeech = true;
          silentFor = 0;
          return;
        }
        if (!heardSpeech) return;
        silentFor += ENDPOINT_TICK_MS;
        if (silentFor < endpointMs) return;
        this.stopVad();
        try {
          media.stop();
        } catch {
          // already stopped
        }
      }, ENDPOINT_TICK_MS);
      return true;
    } catch {
      this.stopVad();
      return false;
    }
  }

  private stopVad() {
    clearInterval(this.vadTimer);
    this.vadTimer = undefined;
    const ctx = this.audioContext;
    this.audioContext = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private async transcribeChunks(mine: number, spaceId: string | null) {
    if (this.token !== mine) return;
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
    this.chunks = [];
    if (!blob.size) {
      this.set(IDLE);
      return;
    }
    this.set({ status: "transcribing", transcript: this.snapshot.transcript });
    const result = await this.transcribeBlob(blob, spaceId, mine);
    if (this.token !== mine || !result.ok) return;
    this.finish(result.text, mine);
  }

  /**
   * One transcription round trip, shared by the one-shot hold/endpoint flow
   * and the continuous dictate-mode chunk loop. On failure it sets the error
   * itself (matching each branch's existing message) and returns `ok: false`;
   * the caller only decides what a successful `text` means for its own flow.
   */
  private async transcribeBlob(
    blob: Blob,
    spaceId: string | null,
    mine: number,
  ): Promise<{ ok: true; text: string } | { ok: false }> {
    const abort = new AbortController();
    this.activeAborts.add(abort);
    const timer = setTimeout(
      () => abort.abort(new Error("Transcription request timed out.")),
      TRANSCRIPTION_RESPONSE_TIMEOUT_MS,
    );
    try {
      const audioBase64 = await blobToBase64(blob);
      if (this.token !== mine) return { ok: false };
      const res = await withAbort(
        fetch("/api/voice/transcribe", {
          method: "POST",
          headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
          credentials: "include",
          body: JSON.stringify({ audioBase64, mimeType: blob.type }),
          signal: abort.signal,
        }),
        abort.signal,
      );
      if (this.token !== mine) {
        cancelResponse(res);
        return { ok: false };
      }
      const body = await readTranscriptionBody(res, abort.signal);
      if (this.token !== mine) return { ok: false };
      if (!res.ok) {
        this.set({ ...IDLE, error: body.error ?? "Could not transcribe that recording." });
        return { ok: false };
      }
      return { ok: true, text: (body.text ?? "").trim() };
    } catch (error) {
      // User cancel bumps token in stop() before aborting, so a matching token
      // means the deadline timer fired. Browsers may reject fetch as AbortError
      // instead of signal.reason; surface the timeout either way.
      if (this.token !== mine) return { ok: false };
      const timedOut =
        (abort.signal.reason instanceof Error &&
          abort.signal.reason.message === "Transcription request timed out.") ||
        (error instanceof Error && error.message === "Transcription request timed out.");
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        this.set({ ...IDLE, error: "Transcription request timed out." });
        return { ok: false };
      }
      this.set({
        ...IDLE,
        error: error instanceof Error ? error.message : "Could not transcribe that recording.",
      });
      return { ok: false };
    } finally {
      clearTimeout(timer);
      this.activeAborts.delete(abort);
    }
  }

  submitHold() {
    if (this.media && this.media.state !== "inactive") {
      this.media.stop();
      return;
    }
    this.finish(this.snapshot.transcript, this.token);
  }

  private finish(text: string, mine: number) {
    if (this.token !== mine) return;
    const trimmed = text.trim();
    const onFinal = this.onFinal;
    this.stop("submit");
    if (trimmed) onFinal?.(trimmed);
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readTranscriptionBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ text?: string; error?: string }> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_TRANSCRIPTION_RESPONSE_BYTES) {
    cancelResponse(response);
    throw new Error("Transcription response is too large.");
  }
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_TRANSCRIPTION_RESPONSE_BYTES,
    tooLargeMessage: "Transcription response is too large.",
    read: (operation) => withAbort(operation(), signal),
  });
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as { text?: string; error?: string })
      : {};
  } catch {
    return {};
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // Prefer abort reason over a bare AbortError from fetch/read.
        reject(signal.aborted ? (signal.reason ?? error) : error);
      },
    );
  });
}

function cancelResponse(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Response cleanup is best-effort.
  }
}

export const dictation = new Dictation();
