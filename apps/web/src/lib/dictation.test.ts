import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Dictation,
  dictationLangFor,
  MAX_TRANSCRIPTION_RESPONSE_BYTES,
  TRANSCRIPTION_RESPONSE_TIMEOUT_MS,
} from "./dictation.js";

describe("dictationLangFor", () => {
  it("dictates in French with a locale the recognizer knows, never the browser's region glued on", () => {
    const french = ["est-ce que ça marche quand je parle", "trouve-moi une raquette"];
    expect(dictationLangFor(french, "en-US")).toBe("fr-FR");
    expect(dictationLangFor(french, "en-GB", ["en-GB", "fr-CA"])).toBe("fr-CA");
    expect(dictationLangFor(french, "en-US", ["en-US", "fr"])).toBe("fr-FR");
  });

  it("falls back to the browser's own language with no clear signal", () => {
    expect(dictationLangFor(["ok"], "en-US")).toBe("en-US");
    expect(dictationLangFor([], "en-US")).toBe("en-US");
  });

  it("keeps the browser's language as-is when it already matches the recent writing", () => {
    expect(dictationLangFor(["can you check what is on my calendar for this week"], "en-US")).toBe(
      "en-US",
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function stubRecorderFallback(fetchMock: ReturnType<typeof vi.fn>) {
  const track = { stop: vi.fn() };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
    },
    language: "en-US",
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "MediaRecorder",
    class {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    },
  );
}

describe("Dictation recorder fallback", () => {
  it("stops tracks if hold-to-talk is cancelled while the mic prompt is open", async () => {
    const track = { stop: vi.fn() };
    let grant!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void;
    const pending = new Promise<{ getTracks: () => Array<{ stop: () => void }> }>((resolve) => {
      grant = resolve;
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => pending) },
      language: "en-US",
    });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        start() {
          started();
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    const listening = dictation.listen({
      mode: "hold",
      transcribe: true,
      onFinal: () => undefined,
    });
    dictation.stop("cancel");
    grant({ getTracks: () => [track] });
    await listening;

    expect(track.stop).toHaveBeenCalledOnce();
    expect(started).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
  });

  it("cancelling a hold recording once the mic is granted still releases the track (matches origin/main)", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
      language: "en-US",
    });
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        // No `onstop` handler at all — a cancel must not depend on it firing
        // to release the mic.
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.stop("cancel");

    expect(track.stop).toHaveBeenCalledOnce();
    expect(dictation.state.status).toBe("idle");
  });

  it("does not deliver a stale transcript to a newer session", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });

    let transcribe!: (body: { text: string }) => void;
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
          );
          transcribe = (body) => resolve(Response.json(body));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const first = vi.fn();
    const second = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: first });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: second });
    transcribe({ text: "stale take" });
    await Promise.resolve();
    await Promise.resolve();

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
  });

  it("keeps transcription in the space where recording started", async () => {
    const store = new Map<string, string>([["rakazo:space-id", "space-support"]]);
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ text: "hello" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal });
    store.set("rakazo:space-id", "space-other");
    dictation.submitHold();
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hello"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/voice/transcribe",
      expect.objectContaining({ credentials: "include" }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-tangow-space-id")).toBe("space-support");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("rejects oversized transcription responses without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchMock = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-length": String(MAX_TRANSCRIPTION_RESPONSE_BYTES + 1) },
        }),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();

    await vi.waitFor(() =>
      expect(dictation.state.error).toBe("Transcription response is too large."),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("times out while a transcription response body is stalled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull: () => new Promise<void>(() => undefined),
          }),
        ),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_RESPONSE_TIMEOUT_MS);

    expect(dictation.state.error).toBe("Transcription request timed out.");
  });

  it("surfaces timeout when fetch rejects with AbortError", async () => {
    // Browsers reject aborted fetch with DOMException AbortError. Matching token
    // means the deadline fired (stop() bumps token first), so this must not stay
    // stuck on "transcribing".
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();

    await vi.waitFor(() => expect(dictation.state.error).toBe("Transcription request timed out."));
    expect(dictation.state.status).toBe("idle");
  });

  it("stays silent when stop cancels an in-flight transcription", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    stubRecorderFallback(fetchMock);
    const dictation = new Dictation();

    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(dictation.state.status).toBe("transcribing");

    dictation.stop("cancel");
    await Promise.resolve();
    await Promise.resolve();

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBeUndefined();
  });

  it("ignores leftover audio from a replaced recorder", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async (_url: string, _init?: { body?: string }) =>
      Response.json({ text: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const recorders: Array<{
      ondataavailable: ((event: { data: Blob }) => void) | null;
      onstop: (() => void) | null;
      stop: () => void;
    }> = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["new"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    await dictation.listen({ mode: "hold", transcribe: true, onFinal: () => undefined });
    recorders[0]?.ondataavailable?.({
      data: new Blob(["STALE-AUDIO-DATA"], { type: "audio/webm" }),
    });
    dictation.submitHold();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "")) as {
      audioBase64: string;
    };
    const decoded = atob(body.audioBase64);
    expect(decoded).toContain("new");
    expect(decoded).not.toContain("STALE");
  });

  it("fails visibly when endpoint dictation has no silence detector", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const started = vi.fn();
    vi.stubGlobal(
      "MediaRecorder",
      class {
        start() {
          started();
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      onFinal: () => undefined,
    });
    expect(started).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(dictation.state.error).toMatch(/stop talking/i);
  });

  it("stops an endpoint recording after silence", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);

    const onFinal = vi.fn();
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    expect(dictation.state.status).toBe("listening");
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync(240);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("hello"));
    vi.useRealTimers();
  });

  it("does not let a replaced recorder tear down the new silence detector", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const level = { current: 0.6 };
    class FakeAnalyser {
      fftSize = 2048;
      getByteTimeDomainData(data: Uint8Array) {
        data.fill(Math.round(128 + level.current * 127));
      }
    }
    class FakeContext {
      state = "running";
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return new FakeAnalyser();
      }
      close() {
        return Promise.resolve();
      }
      resume() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeContext);

    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
      },
      language: "en-US",
    });
    const fetchMock = vi.fn(async () => Response.json({ text: "later" }));
    vi.stubGlobal("fetch", fetchMock);

    const recorders: Array<{
      onstop: (() => void) | null;
      stop: () => void;
    }> = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const onFinal = vi.fn();
    const dictation = new Dictation();
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    const staleStop = recorders[0]?.onstop;
    await dictation.listen({
      mode: "endpoint",
      transcribe: true,
      endpointMs: 240,
      onFinal,
    });
    staleStop?.();
    await vi.advanceTimersByTimeAsync(80);
    level.current = 0;
    await vi.advanceTimersByTimeAsync(240);
    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith("later"));
    vi.useRealTimers();
  });
});

describe("Dictation web speech", () => {
  it("restarts endpoint recognition after a quiet end", async () => {
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { language: "en-US" });

    const dictation = new Dictation();
    await dictation.listen({ mode: "endpoint", onFinal: () => undefined });
    const rec = instances[0];
    expect(rec?.start).toHaveBeenCalledOnce();
    rec?.onend?.();
    expect(rec?.start).toHaveBeenCalledTimes(2);
    expect(dictation.state.status).toBe("listening");
  });
});

describe("Dictation dictate mode", () => {
  function fakeRecognitionCtor(instances: FakeRecognition[]) {
    return class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this as unknown as FakeRecognition);
      }
    };
  }

  it("separates final from interim text and survives a natural restart (web speech)", async () => {
    const instances: FakeRecognition[] = [];
    vi.stubGlobal("window", { SpeechRecognition: fakeRecognitionCtor(instances) });
    vi.stubGlobal("navigator", { language: "en-US" });

    const dictation = new Dictation();
    await dictation.listen({ mode: "dictate", onFinal: () => undefined });
    const rec = instances[0];
    rec?.onresult?.({
      results: [
        { isFinal: true, 0: { transcript: "Hello" } },
        { isFinal: false, 0: { transcript: "wor" } },
      ],
    });
    expect(dictation.state.transcript).toBe("Hello");
    expect(dictation.state.interim).toBe("wor");

    // iOS Web Speech naturally ends after ~3s of silence; dictate mode must
    // restart (same instance, `.start()` called again) rather than exit
    // (only ✓/×/forced-cancel do). The browser's new session starts its own
    // `results` list over from empty, same as this fake.
    rec?.onend?.();
    expect(rec?.start).toHaveBeenCalledTimes(2);
    expect(dictation.state.status).toBe("listening");
    expect(dictation.state.transcript).toBe("Hello");
    expect(dictation.state.interim).toBe("");

    rec?.onresult?.({ results: [{ isFinal: true, 0: { transcript: "world" } }] });
    expect(dictation.state.transcript).toBe("Hello world");
    expect(dictation.state.interim).toBe("");
  });

  it("does not finish the session when the transcript is non-empty at a natural end", async () => {
    // Endpoint mode finalizes on a quiet `onend` with text present; dictate
    // mode must not — only stop() (×/✓/forced-cancel) ends the session.
    const instances: FakeRecognition[] = [];
    vi.stubGlobal("window", { SpeechRecognition: fakeRecognitionCtor(instances) });
    vi.stubGlobal("navigator", { language: "en-US" });
    const onFinal = vi.fn();

    const dictation = new Dictation();
    await dictation.listen({ mode: "dictate", onFinal });
    const rec = instances[0];
    rec?.onresult?.({ results: [{ isFinal: true, 0: { transcript: "hello" } }] });
    rec?.onend?.();

    expect(onFinal).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
  });

  it("ends the session with an error when recognition refuses to start", async () => {
    const instances: FakeRecognition[] = [];
    const Ctor = fakeRecognitionCtor(instances);
    class ThrowingRecognition extends Ctor {
      override start = vi.fn(() => {
        throw new Error("recognition has already started");
      });
    }
    vi.stubGlobal("window", { SpeechRecognition: ThrowingRecognition });
    vi.stubGlobal("navigator", { language: "en-US" });

    const dictation = new Dictation();
    await dictation.listen({ mode: "dictate", onFinal: () => undefined });

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBe("Dictation failed: recognition has already started");
  });

  it("keeps listening across chunks and stops cleanly mid-chunk (recorder fallback)", async () => {
    const tracks: Array<{ stop: () => void }> = [];
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          const track = { stop: vi.fn() };
          tracks.push(track);
          return { getTracks: () => [track] };
        }),
      },
      language: "en-US",
    });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return Response.json({ text: `chunk${call}` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    // The chunk timer itself isn't under test here (it's a plain `setTimeout`
    // in `recordChunk`); each iteration below is driven explicitly by calling
    // `stop()` on the recorder, standing in for that timer firing, so the
    // loop only ever advances as far as this test lets it — never in a tight,
    // unbounded microtask loop that could run away before an assertion gets
    // a chance to end it.
    const listening = dictation.listen({
      mode: "dictate",
      transcribe: true,
      onFinal: () => undefined,
    });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0]?.stop();
    await vi.waitFor(() => expect(dictation.state.transcript).toBe("chunk1"));

    await vi.waitFor(() => expect(recorders).toHaveLength(2));
    recorders[1]?.stop();
    await vi.waitFor(() => expect(dictation.state.transcript).toBe("chunk1 chunk2"));

    // Stop mid-chunk (before the third recorder is told to stop): the
    // in-flight recorder is torn down, its track released, and no further
    // chunk is transcribed.
    await vi.waitFor(() => expect(recorders).toHaveLength(3));
    const callsBeforeStop = fetchMock.mock.calls.length;
    dictation.stop("cancel");
    await listening;

    expect(dictation.state.status).toBe("idle");
    expect(fetchMock.mock.calls.length).toBe(callsBeforeStop);
    expect(tracks.at(-1)?.stop).toHaveBeenCalled();
  });

  it("stops recording without transcribing once the caller has stopped listening", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
      language: "en-US",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    const listening = dictation.listen({
      mode: "dictate",
      transcribe: true,
      onFinal: () => undefined,
    });
    dictation.stop("cancel");
    await listening;

    expect(track.stop).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("idle");
  });

  it("keeps recording the next chunk while the previous one is still transcribing, and appends in order", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
      language: "en-US",
    });
    let resolveFirst!: (body: { text: string }) => void;
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Promise<Response>((resolve) => {
          resolveFirst = (body) => resolve(Response.json(body));
        });
      }
      return Response.json({ text: "second" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0]?.stop();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    // The first chunk's request is still pending, yet capture already moved
    // on to the next chunk instead of waiting on it.
    await vi.waitFor(() => expect(recorders).toHaveLength(2));
    expect(recorders[1]?.state).toBe("recording");
    expect(dictation.state.transcript).toBe("");

    recorders[1]?.stop();
    // The second chunk's own request only starts once the chain reaches it —
    // requests are transcribed in order — so nothing has appended yet.
    expect(dictation.state.transcript).toBe("");
    resolveFirst({ text: "first" });
    await vi.waitFor(() => expect(dictation.state.transcript).toBe("first second"));
  });

  it("✓ waits for the last partial chunk instead of dropping it", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
      language: "en-US",
    });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return Response.json({ text: `chunk${call}` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0]?.stop();
    await vi.waitFor(() => expect(dictation.state.transcript).toBe("chunk1"));
    await vi.waitFor(() => expect(recorders).toHaveLength(2));

    // ✓ while the second chunk is still recording (its 4s timer hasn't fired):
    // finishDictate stops it, transcribes it, and includes it in the result.
    const finished = dictation.finishDictate();
    expect(dictation.state.status).toBe("transcribing");
    const text = await finished;

    expect(text).toBe("chunk1 chunk2");
    expect(recorders[1]?.state).toBe("inactive");
    expect(dictation.state.status).toBe("idle");
  });

  it("✓ right after the chunk timer stopped the recorder still waits for that chunk", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
      language: "en-US",
    });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return Response.json({ text: `chunk${call}` });
      }),
    );

    // Like a real MediaRecorder: `state` flips at once, the data and stop
    // events arrive later.
    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
          this.onstop?.();
        }, 0);
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0]?.stop();
    await vi.waitFor(() => expect(dictation.state.transcript).toBe("chunk1"));
    await vi.waitFor(() => expect(recorders).toHaveLength(2));

    // The 4s chunk timer stops the second recorder; ✓ lands before its stop event.
    recorders[1]?.stop();
    expect(recorders[1]?.state).toBe("inactive");
    const text = await dictation.finishDictate();

    expect(text).toBe("chunk1 chunk2");
    expect(dictation.state.status).toBe("idle");
  });

  it("× drops everything immediately, including a chunk transcription in flight", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
      language: "en-US",
    });
    let resolveFetch!: (body: { text: string }) => void;
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
          );
          resolveFetch = (body) => resolve(Response.json(body));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0]?.stop();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    dictation.stop("cancel");
    resolveFetch({ text: "too late" });
    await Promise.resolve();
    await Promise.resolve();

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.transcript).toBe("");
    expect(track.stop).toHaveBeenCalled();
  });

  it("✓ keeps what was already transcribed when the last chunk fails", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
      language: "en-US",
    });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? Response.json({ text: "earlier" })
          : new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
      }),
    );

    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0]?.stop();
    await vi.waitFor(() => expect(dictation.state.transcript).toBe("earlier"));
    await vi.waitFor(() => expect(recorders).toHaveLength(2));

    await expect(dictation.finishDictate()).resolves.toBe("earlier");
    expect(dictation.state.status).toBe("idle");
    // Partial text, so the error stays for the composer to show.
    expect(dictation.state.error).toBe("Too many requests");
  });

  it("✓ in the gap after the chunk timer stopped the recorder still transcribes that chunk", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
      language: "en-US",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ text: "pending chunk" })),
    );

    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      // Like a real recorder: inactive at once, the stop event comes later.
      stop() {
        this.state = "inactive";
      }
      fireStop() {
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0]?.stop();

    const finished = dictation.finishDictate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    recorders[0]?.fireStop();

    await expect(finished).resolves.toBe("pending chunk");
    expect(recorders).toHaveLength(1);
    expect(dictation.state.error).toBeUndefined();
  });

  it("a failed chunk transcription ends the whole session instead of looping", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
      language: "en-US",
    });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "Server error" }), { status: 502 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
      state = "inactive";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(recorders).toHaveLength(1));
    recorders[0]?.stop();

    await vi.waitFor(() => expect(dictation.state.status).toBe("idle"));
    expect(dictation.state.error).toBeTruthy();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    // The second chunk (started right after the first one's recorder
    // stopped, before its transcription result was known) gets torn down
    // too, and no third chunk ever starts.
    expect(recorders).toHaveLength(2);
    expect(recorders[1]?.state).toBe("inactive");
  });

  it("a cancel racing ✓ between the recorder's stop and its stop event doesn't hang finishDictate", async () => {
    const track = { stop: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
      language: "en-US",
    });
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        onstop: (() => void) | null = null;
        start() {
          this.state = "recording";
        }
        // Deliberately never calls `onstop` — the real event is
        // asynchronous, and this is the window a cancel can land in.
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(dictation.state.status).toBe("listening"));

    const finished = dictation.finishDictate();
    expect(dictation.state.status).toBe("transcribing");
    dictation.stop("cancel");

    await expect(finished).resolves.toBe("");
    expect(dictation.state.status).toBe("idle");
    expect(track.stop).toHaveBeenCalled();
  });
});

describe("Dictation desktop engine preference", () => {
  it("skips Web Speech and goes straight to the provider when preferTranscribe is set", async () => {
    const started = vi.fn();
    vi.stubGlobal("window", {
      SpeechRecognition: class {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult = null;
        onerror = null;
        onend = null;
        start() {
          started();
        }
        stop() {}
        abort() {}
      },
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
      language: "en-US",
    });
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    await dictation.listen({
      mode: "dictate",
      transcribe: true,
      preferTranscribe: true,
      onFinal: () => undefined,
    });

    expect(started).not.toHaveBeenCalled();
    expect(dictation.state.status).toBe("listening");
  });

  it("falls back to the provider when Web Speech errors with network at start", async () => {
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
      language: "en-US",
    });
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal(
      "MediaRecorder",
      class {
        state = "inactive";
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
        }
      },
    );

    const dictation = new Dictation();
    void dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    instances[0]?.onerror?.({ error: "network" });

    // Falls through to the recorder fallback instead of failing outright.
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    expect(dictation.state.status).toBe("listening");
    expect(dictation.state.error).toBeUndefined();
  });

  it("does not fall back once real speech has already been recognized", async () => {
    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("window", { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("navigator", { language: "en-US" });

    const dictation = new Dictation();
    await dictation.listen({ mode: "dictate", transcribe: true, onFinal: () => undefined });
    const rec = instances[0];
    rec?.onresult?.({ results: [{ isFinal: true, 0: { transcript: "hello" } }] });
    rec?.onerror?.({ error: "network" });

    expect(dictation.state.status).toBe("idle");
    expect(dictation.state.error).toBe("Dictation failed: network");
  });
});

interface FakeRecognition {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
