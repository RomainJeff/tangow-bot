import type * as SpeechRecognition from "expo-speech-recognition";
import { Platform } from "react-native";

/**
 * The only file that imports `expo-speech-recognition` (AGENTS.md: vendor
 * SDKs stay behind one small adapter). On-device only: the module is
 * always started with `requiresOnDeviceRecognition: true`, so no audio ever
 * leaves the device. Continuous mode restarts itself when the engine ends on
 * its own (iOS 17- stops after ~3 s of silence) — only a caller-driven
 * stop/abort, or this module's own caps, end the session for good.
 */

export type DictationEndReason = "denied" | "error" | "caps";

export interface DictationCallbacks {
  /** The full dictated text so far (accumulated final segments + the
   * current interim tail). `isFinal` says whether the chunk that produced
   * this update was itself final — the caller uses it to know how much of
   * the text is still provisional. */
  onText: (text: string, isFinal: boolean) => void;
  /** Fires once, right before the engine actually starts listening (i.e.
   * once permission is confirmed granted). The caller uses this to know
   * when a pending permission request is over, so it can start reacting to
   * background/foreground changes as "the mic is really on" rather than
   * "the system permission sheet is showing". */
  onStart?: () => void;
  /** The engine's current input level, forwarded from its `volumechange`
   * event when the module supports it (`-2`..`10`, at or below 0 read as
   * silent). Omitted entirely for engines/devices that never report one. */
  onVolume?: (value: number) => void;
  /** Fires once, when the session ends for a reason the caller didn't
   * itself request (permission denied, an unrecoverable engine error, or a
   * cap). A caller-requested `stopDictation`/`abortDictation` does not call
   * this — the caller already knows why it stopped. For `"denied"`, the
   * second argument says whether permission was already denied before this
   * attempt (the caller uses it to decide whether refusing the system
   * prompt itself should show the "Open Settings" alert, or just exit
   * quietly). */
  onEnd: (reason: DictationEndReason, alreadyDenied?: boolean) => void;
  /** The language the person writes in (`fr`), when known: it wins over the
   * phone's own language, which may not be the one they speak. */
  spokenLanguage?: string;
}

/** no more than 60 s without a new result, or 5 min total. */
const SILENCE_CAP_MS = 60_000;
const TOTAL_CAP_MS = 5 * 60_000;

type SpeechModule = typeof SpeechRecognition;

// Loaded lazily so an over-the-air update landing on an older binary without
// the native module hides the mic instead of crashing the thread screen.
let loadModulePromise: Promise<SpeechModule | null> | null = null;

async function loadModule(): Promise<SpeechModule | null> {
  loadModulePromise ??= import("expo-speech-recognition").catch(() => null);
  return loadModulePromise;
}

function androidVersion(): number {
  const version = Platform.OS === "android" ? Number(Platform.Version) : Number.NaN;
  return Number.isFinite(version) ? version : 0;
}

/** The device's speech locale — same source as the rest of the app's i18n
 * fallback (`lib/i18n.ts`), so no extra native dependency is needed just to
 * ask "what language is this phone in". */
function deviceLocale(): string {
  try {
    const locale = globalThis.Intl?.DateTimeFormat().resolvedOptions().locale;
    return locale || "en-US";
  } catch {
    return "en-US";
  }
}

/**
 * The recognizer's own locale for the device's: iOS only accepts an exact
 * identifier from its supported list, and a phone set to English in France
 * reports `en-FR`, which it refuses on the spot (the dictation closed as soon
 * as it opened). Exact match first, then the same language in the device's
 * region, then the language's usual locale (`en-US` for `en`), then any
 * locale of that language. `undefined` when the language has none.
 */
export function speechLocaleFor(
  requested: string,
  supported: readonly string[],
): string | undefined {
  const normalize = (locale: string) => locale.replace(/_/g, "-").toLowerCase();
  const wanted = normalize(requested).split("-u-")[0]!;
  const [language, ...rest] = wanted.split("-");
  const region = rest.find((part) => /^[a-z]{2}$/.test(part));
  const byNormal = new Map(supported.map((locale) => [normalize(locale), locale]));
  const exact = byNormal.get(wanted);
  if (exact) return exact;
  if (region) {
    const sameRegion = byNormal.get(`${language}-${region}`);
    if (sameRegion) return sameRegion;
  }
  const usual = byNormal.get(`${language}-${USUAL_REGION[language ?? ""] ?? language}`);
  if (usual) return usual;
  return supported.find((locale) => normalize(locale).split("-")[0] === language);
}

/** The region a language's speech model is usually published under. */
const USUAL_REGION: Record<string, string> = {
  en: "us",
  fr: "fr",
  es: "es",
  de: "de",
  it: "it",
  pt: "br",
  ru: "ru",
  zh: "cn",
  ja: "jp",
  ko: "kr",
  nl: "nl",
};

/** The spoken language in the device's region (`fr` on an `en-FR` phone gives `fr-FR`). */
function requestedLocale(spokenLanguage: string | undefined): string {
  const device = deviceLocale();
  if (!spokenLanguage) return device;
  const [language, region] = device.replace(/_/g, "-").split("-");
  if (language?.toLowerCase() === spokenLanguage) return device;
  return region ? `${spokenLanguage}-${region}` : spokenLanguage;
}

/** the mic is only shown once on-device recognition is actually usable —
 * Android below 13 has no offline model at all, and older/limited devices or
 * an unsupported locale report `false` from the module itself. */
export async function dictationAvailable(): Promise<boolean> {
  if (Platform.OS === "android" && androidVersion() < 33) return false;
  const mod = await loadModule();
  if (!mod) return false;
  try {
    const { ExpoSpeechRecognitionModule } = mod;
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) return false;
    return ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
  } catch {
    return false;
  }
}

interface DictationSession {
  requestStop: () => void;
  requestAbort: () => void;
}

let session: DictationSession | null = null;

// `startDictation` is async and does most of its work — checking
// availability, loading the module, asking for permission — before there is
// a `session` to abort. Without a way to cancel that in-flight work, a forced
// cancel that lands during the permission prompt (iOS reports `inactive`
// while its alert is up, Android reports `background` while its own
// permission activity is on top) had nothing to abort, so the engine still
// started once the user granted permission — with the dictation UI already
// gone. `pendingStart` is a token for exactly that window: `startDictation`
// checks it after every `await`, and `abortDictation`/`stopDictation` clear
// it, so a cancel that happens before the session exists still prevents the
// engine from ever starting.
let pendingStart: symbol | null = null;

function combinedText(finalizedText: string, interim: string): string {
  if (!interim) return finalizedText;
  if (!finalizedText) return interim;
  return finalizedText.endsWith(" ") ? `${finalizedText}${interim}` : `${finalizedText} ${interim}`;
}

/** Starts a dictation session. Requests permission on first use;
 * `onEnd("denied")` on refusal. Restarts on a natural engine end while still
 * active; only `stopDictation`/`abortDictation`, or the silence/total
 * caps, end it for good. A second call while one is active (or one is still
 * starting) is a no-op. */
export async function startDictation(callbacks: DictationCallbacks): Promise<void> {
  if (session || pendingStart) return;
  const token = Symbol("dictation-start");
  pendingStart = token;
  const cancelled = () => pendingStart !== token;

  const available = await dictationAvailable();
  if (cancelled()) return; // aborted while checking availability — the caller already exited its UI.
  if (!available) {
    pendingStart = null;
    callbacks.onEnd("error");
    return;
  }
  const mod = await loadModule();
  if (cancelled()) return;
  if (!mod) {
    pendingStart = null;
    callbacks.onEnd("error");
    return;
  }
  const { ExpoSpeechRecognitionModule } = mod;
  // Read before requesting — requesting can itself change the status by
  // showing (and having the user answer) the system prompt, so this is the
  // only way to know whether it was already denied *before* this attempt.
  const priorPermission = await ExpoSpeechRecognitionModule.getPermissionsAsync().catch(() => null);
  if (cancelled()) return;
  const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync().catch(() => null);
  if (cancelled()) return; // aborted while the permission prompt was up — never start the engine.
  if (!permission?.granted) {
    pendingStart = null;
    // Android reports `denied` after a single refusal while it can still ask
    // again; only a denial the system will no longer prompt for needs Settings.
    callbacks.onEnd(
      "denied",
      priorPermission?.status === "denied" && priorPermission.canAskAgain === false,
    );
    return;
  }
  const supportedLocales = await ExpoSpeechRecognitionModule.getSupportedLocales({})
    .then((result) => result.locales)
    .catch(() => [] as string[]);
  if (cancelled()) return; // aborted while listing the locales.
  const lang =
    speechLocaleFor(requestedLocale(callbacks.spokenLanguage), supportedLocales) ??
    speechLocaleFor(deviceLocale(), supportedLocales) ??
    deviceLocale();
  pendingStart = null;
  callbacks.onStart?.();

  let finalizedText = "";
  // Set right before we ask the engine to stop/abort, so the `end` (and any
  // `error: "aborted"`) event that follows knows this was requested, and why.
  let pendingReason: DictationEndReason | "requested" | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  let totalCapTimer: ReturnType<typeof setTimeout> | undefined;
  let subscriptions: Array<{ remove: () => void }> = [];
  let finished = false;

  const clearTimers = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (totalCapTimer) clearTimeout(totalCapTimer);
  };

  function finish(reason: DictationEndReason | "requested") {
    if (finished) return;
    finished = true;
    session = null;
    clearTimers();
    for (const subscription of subscriptions) subscription.remove();
    subscriptions = [];
    if (reason === "requested") return;
    if (reason === "denied") {
      // The engine itself reported permission as gone (revoked mid-session,
      // not the user answering the initial prompt) — unambiguous, so this
      // always counts as "already denied".
      callbacks.onEnd(reason, true);
      return;
    }
    callbacks.onEnd(reason);
  }

  function requestAbort(reason: DictationEndReason | "requested") {
    if (finished || pendingReason) return;
    pendingReason = reason;
    ExpoSpeechRecognitionModule.abort();
  }

  const armSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => requestAbort("caps"), SILENCE_CAP_MS);
  };

  function startEngine() {
    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
      requiresOnDeviceRecognition: true,
      ...(callbacks.onVolume
        ? { volumeChangeEventOptions: { enabled: true, intervalMillis: 100 } }
        : {}),
    });
  }

  subscriptions = [
    ExpoSpeechRecognitionModule.addListener("result", (event) => {
      armSilenceTimer();
      const transcript = event.results[0]?.transcript ?? "";
      if (event.isFinal) {
        finalizedText = combinedText(finalizedText, transcript);
        callbacks.onText(finalizedText, true);
      } else {
        callbacks.onText(combinedText(finalizedText, transcript), false);
      }
    }),
    ExpoSpeechRecognitionModule.addListener("error", (event) => {
      if (event.error === "aborted") return; // our own abort() — the `end` listener finishes it.
      if (event.error === "not-allowed") {
        finish("denied");
        return;
      }
      if (event.error === "no-speech" || event.error === "speech-timeout") {
        // A pause, not a failure: iOS's own engine cuts a session after ~3 s
        // of silence and reports it as `no-speech`; Android maps its
        // `ERROR_NO_MATCH`/`ERROR_SPEECH_TIMEOUT` the same way before tearing
        // the recognizer down. Either way the `end` event that follows is a
        // natural end, so it restarts the engine below and keeps whatever
        // was already dictated instead of throwing the session away.
        return;
      }
      finish("error");
    }),
    // A final result with no significant recognition — not a failure either;
    // the natural `end` that follows restarts the engine the same way.
    ExpoSpeechRecognitionModule.addListener("nomatch", () => {}),
    ExpoSpeechRecognitionModule.addListener("end", () => {
      if (finished) return;
      if (pendingReason) {
        finish(pendingReason);
        return;
      }
      // Natural end while dictation is still active (e.g. iOS 17- after ~3 s
      // of silence): keep listening instead of ending the session.
      startEngine();
    }),
  ];
  if (callbacks.onVolume) {
    const onVolume = callbacks.onVolume;
    subscriptions.push(
      ExpoSpeechRecognitionModule.addListener("volumechange", (event) => onVolume(event.value)),
    );
  }

  totalCapTimer = setTimeout(() => requestAbort("caps"), TOTAL_CAP_MS);
  armSilenceTimer();

  session = {
    requestStop: () => {
      if (finished || pendingReason) return;
      pendingReason = "requested";
      ExpoSpeechRecognitionModule.stop();
    },
    requestAbort: () => requestAbort("requested"),
  };
  startEngine();
}

/** Stops gracefully, so a last in-flight result can still land (Insert). If
 * the engine hasn't started yet (still awaiting permission), cancels that
 * pending start instead — there's nothing to gracefully finish. No-op once
 * neither is true. */
export function stopDictation(): void {
  if (session) {
    session.requestStop();
    return;
  }
  pendingStart = null;
}

/** Cancels immediately, discarding whatever the engine hasn't finalized yet.
 * Use for every forced-cancel path (Cancel, backgrounding, thread change,
 * unmount). If the engine hasn't started yet (still awaiting permission),
 * cancels that pending start instead, so it never starts once permission
 * resolves. No-op once neither is true. */
export function abortDictation(): void {
  if (session) {
    session.requestAbort();
    return;
  }
  pendingStart = null;
}

/**
 * Whether an app-state change means the user left while dictating. The mic
 * and speech permission prompts are system alerts that themselves report a
 * non-active state (`inactive` on iOS, `background` on Android), so nothing
 * cancels while a permission request is pending: the engine cannot start
 * until it is answered. Once running, any non-active state on iOS (app
 * switcher, Control Center, a call) and `background` on Android cancel.
 */
export function cancelsDictationOnAppState(
  state: string,
  platform: string,
  permissionPending: boolean,
): boolean {
  if (state === "active" || permissionPending) return false;
  return platform === "ios" || state === "background";
}
