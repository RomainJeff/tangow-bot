import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DictationModule from "./dictation";

type Listener = (event: unknown) => void;

const listeners: Record<string, Listener[]> = {};

function emit(event: string, payload?: unknown) {
  for (const listener of listeners[event] ?? []) listener(payload);
}

const isRecognitionAvailable = vi.fn(() => true);
const supportsOnDeviceRecognition = vi.fn(() => true);
const getPermissionsAsync = vi.fn(
  async (): Promise<{ granted: boolean; status: string; canAskAgain?: boolean }> => ({
    granted: false,
    status: "undetermined",
  }),
);
const requestPermissionsAsync = vi.fn(async () => ({ granted: true }));
const start = vi.fn();
const stop = vi.fn();
const abort = vi.fn();
const addListener = vi.fn((event: string, listener: Listener) => {
  listeners[event] ??= [];
  listeners[event].push(listener);
  return {
    remove: () => {
      listeners[event] = (listeners[event] ?? []).filter((candidate) => candidate !== listener);
    },
  };
});

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "17.0" } }));
vi.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable,
    supportsOnDeviceRecognition,
    getPermissionsAsync,
    requestPermissionsAsync,
    start,
    stop,
    abort,
    addListener,
  },
}));

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("dictation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    for (const key of Object.keys(listeners)) delete listeners[key];
    isRecognitionAvailable.mockReturnValue(true);
    supportsOnDeviceRecognition.mockReturnValue(true);
    getPermissionsAsync.mockResolvedValue({ granted: false, status: "undetermined" });
    requestPermissionsAsync.mockResolvedValue({ granted: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start when unavailable, and does not touch the engine", async () => {
    supportsOnDeviceRecognition.mockReturnValue(false);
    const { startDictation } = await import("./dictation");
    const onText = vi.fn();
    const onEnd = vi.fn();
    await startDictation({ onText, onEnd });
    expect(start).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledWith("error");
  });

  it("always requests on-device recognition with continuous, interim results", async () => {
    const { startDictation } = await import("./dictation");
    await startDictation({ onText: vi.fn(), onEnd: vi.fn() });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresOnDeviceRecognition: true,
        continuous: true,
        interimResults: true,
      }),
    );
  });

  it('onEnd("denied", false) on the system prompt\'s own first refusal — no "already denied" before this tap', async () => {
    getPermissionsAsync.mockResolvedValue({ granted: false, status: "undetermined" });
    requestPermissionsAsync.mockResolvedValue({ granted: false });
    const { startDictation } = await import("./dictation");
    const onEnd = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd });
    expect(start).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledWith("denied", false);
  });

  it('onEnd("denied", true) when permission was already denied for good before this tap', async () => {
    getPermissionsAsync.mockResolvedValue({ granted: false, status: "denied", canAskAgain: false });
    requestPermissionsAsync.mockResolvedValue({ granted: false });
    const { startDictation } = await import("./dictation");
    const onEnd = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd });
    expect(start).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledWith("denied", true);
  });

  it('onEnd("denied", false) while the system can still ask again (Android after one refusal)', async () => {
    getPermissionsAsync.mockResolvedValue({ granted: false, status: "denied", canAskAgain: true });
    requestPermissionsAsync.mockResolvedValue({ granted: false });
    const { startDictation } = await import("./dictation");
    const onEnd = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd });
    expect(onEnd).toHaveBeenCalledWith("denied", false);
  });

  it("restarts the engine on a natural end while still active, without ending the session", async () => {
    const { startDictation } = await import("./dictation");
    const onEnd = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd });
    expect(start).toHaveBeenCalledTimes(1);
    emit("end");
    expect(start).toHaveBeenCalledTimes(2);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("accumulates final segments and reports the running text with each update", async () => {
    const { startDictation } = await import("./dictation");
    const onText = vi.fn();
    await startDictation({ onText, onEnd: vi.fn() });
    emit("result", { isFinal: false, results: [{ transcript: "hello" }] });
    emit("result", { isFinal: true, results: [{ transcript: "hello there" }] });
    emit("result", { isFinal: false, results: [{ transcript: "friend" }] });
    expect(onText).toHaveBeenNthCalledWith(1, "hello", false);
    expect(onText).toHaveBeenNthCalledWith(2, "hello there", true);
    expect(onText).toHaveBeenNthCalledWith(3, "hello there friend", false);
  });

  it("stopDictation lets a trailing final result land before the session ends", async () => {
    const { startDictation, stopDictation } = await import("./dictation");
    const onText = vi.fn();
    const onEnd = vi.fn();
    await startDictation({ onText, onEnd });
    stopDictation();
    expect(stop).toHaveBeenCalledOnce();
    // The engine's trailing final result still arrives before `end`.
    emit("result", { isFinal: true, results: [{ transcript: "done" }] });
    emit("end");
    expect(onText).toHaveBeenCalledWith("done", true);
    // A requested stop is not reported through onEnd — the caller already knows.
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("abortDictation cancels immediately and ignores the resulting aborted error", async () => {
    const { startDictation, abortDictation } = await import("./dictation");
    const onEnd = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd });
    abortDictation();
    expect(abort).toHaveBeenCalledOnce();
    emit("error", { error: "aborted", message: "aborted" });
    emit("end");
    expect(onEnd).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1); // no restart after a requested abort
  });

  it('ends with "caps" after 60 s without a new result', async () => {
    vi.useFakeTimers();
    const { startDictation } = await import("./dictation");
    const onEnd = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd });
    vi.advanceTimersByTime(60_000);
    expect(abort).toHaveBeenCalledOnce();
    emit("end"); // the engine's own end, following our abort()
    expect(onEnd).toHaveBeenCalledWith("caps");
  });

  it('ends with "caps" after 5 minutes total, even with ongoing results', async () => {
    vi.useFakeTimers();
    const { startDictation } = await import("./dictation");
    const onText = vi.fn();
    const onEnd = vi.fn();
    await startDictation({ onText, onEnd });
    // A result every 10 s keeps the silence timer from firing on its own.
    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(10_000);
      emit("result", { isFinal: true, results: [{ transcript: "word" }] });
    }
    expect(abort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(abort).toHaveBeenCalledOnce();
    emit("end");
    expect(onEnd).toHaveBeenCalledWith("caps");
  });

  it("a second startDictation call while one is active is a no-op", async () => {
    const { startDictation } = await import("./dictation");
    await startDictation({ onText: vi.fn(), onEnd: vi.fn() });
    await startDictation({ onText: vi.fn(), onEnd: vi.fn() });
    expect(requestPermissionsAsync).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    await flushMicrotasks();
  });

  it("calls onStart once permission is granted, right before the engine starts", async () => {
    const { startDictation } = await import("./dictation");
    const onStart = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd: vi.fn(), onStart });
    expect(onStart).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(1);
  });

  describe("a pending start (permission still being requested)", () => {
    function deferPermission() {
      let resolve: (value: { granted: boolean }) => void = () => {};
      requestPermissionsAsync.mockImplementation(
        () =>
          new Promise((res) => {
            resolve = res;
          }),
      );
      return (granted: boolean) => resolve({ granted });
    }

    it("abortDictation cancels it: the engine never starts once permission resolves", async () => {
      const grant = deferPermission();
      const { startDictation, abortDictation } = await import("./dictation");
      const onEnd = vi.fn();
      const started = startDictation({ onText: vi.fn(), onEnd });
      await flushMicrotasks();
      abortDictation();
      grant(true);
      await started;
      expect(start).not.toHaveBeenCalled();
      // Nothing to report — the caller (the hook's cancel()) already left
      // dictation mode synchronously; there is no "denied" or "error" here.
      expect(onEnd).not.toHaveBeenCalled();
    });

    it("stopDictation (✓ tapped before the engine is even running) also cancels it", async () => {
      const grant = deferPermission();
      const { startDictation, stopDictation } = await import("./dictation");
      const onEnd = vi.fn();
      const started = startDictation({ onText: vi.fn(), onEnd });
      await flushMicrotasks();
      stopDictation();
      grant(true);
      await started;
      expect(start).not.toHaveBeenCalled();
      expect(onEnd).not.toHaveBeenCalled();
    });

    it("lets a fresh startDictation call proceed once a cancelled one has cleared", async () => {
      const grant = deferPermission();
      const { startDictation, abortDictation } = await import("./dictation");
      const started = startDictation({ onText: vi.fn(), onEnd: vi.fn() });
      await flushMicrotasks();
      abortDictation();
      grant(true);
      await started;
      requestPermissionsAsync.mockResolvedValue({ granted: true });
      await startDictation({ onText: vi.fn(), onEnd: vi.fn() });
      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  it.each(["no-speech", "speech-timeout"] as const)(
    'treats a "%s" error as a pause, not a failure: it does not end the session, and the following `end` restarts the engine',
    async (errorCode) => {
      const { startDictation } = await import("./dictation");
      const onEnd = vi.fn();
      await startDictation({ onText: vi.fn(), onEnd });
      emit("error", { error: errorCode, message: errorCode });
      expect(onEnd).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1); // no restart yet — that's the `end` event's job
      emit("end");
      expect(start).toHaveBeenCalledTimes(2);
      expect(onEnd).not.toHaveBeenCalled();
    },
  );

  it('ignores a "nomatch" event (a final result with nothing recognized) and restarts on the end that follows', async () => {
    const { startDictation } = await import("./dictation");
    const onEnd = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd });
    emit("nomatch", null);
    expect(onEnd).not.toHaveBeenCalled();
    emit("end");
    expect(start).toHaveBeenCalledTimes(2);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("asks the engine for volumechange events, and forwards them, only when the caller wants them", async () => {
    const { startDictation } = await import("./dictation");
    const onVolume = vi.fn();
    await startDictation({ onText: vi.fn(), onEnd: vi.fn(), onVolume });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
      }),
    );
    emit("volumechange", { value: 4.2 });
    expect(onVolume).toHaveBeenCalledWith(4.2);
  });

  it("does not ask for volumechange events when no caller wants them", async () => {
    const { startDictation } = await import("./dictation");
    await startDictation({ onText: vi.fn(), onEnd: vi.fn() });
    const options = start.mock.calls[0]?.[0] as { volumeChangeEventOptions?: unknown };
    expect(options.volumeChangeEventOptions).toBeUndefined();
  });
});

describe("cancelsDictationOnAppState", () => {
  let cancelsDictationOnAppState: typeof DictationModule.cancelsDictationOnAppState;
  beforeEach(async () => {
    ({ cancelsDictationOnAppState } = await import("./dictation"));
  });

  it("ignores the permission prompt's own state change on both platforms", () => {
    expect(cancelsDictationOnAppState("inactive", "ios", true)).toBe(false);
    expect(cancelsDictationOnAppState("background", "android", true)).toBe(false);
  });

  it("cancels on any non-active state on iOS once running", () => {
    expect(cancelsDictationOnAppState("inactive", "ios", false)).toBe(true);
    expect(cancelsDictationOnAppState("background", "ios", false)).toBe(true);
  });

  it("cancels only on background on Android once running", () => {
    expect(cancelsDictationOnAppState("inactive", "android", false)).toBe(false);
    expect(cancelsDictationOnAppState("background", "android", false)).toBe(true);
  });

  it("never cancels on becoming active", () => {
    expect(cancelsDictationOnAppState("active", "ios", false)).toBe(false);
  });
});
