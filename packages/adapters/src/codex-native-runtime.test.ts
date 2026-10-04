import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntimeEvent,
  ComputerRef,
  NativeProcess,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import {
  CodexNativeRuntime,
  stopAndClearParkedCodexRuntimeForTest,
} from "./computer-native-runtime.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "computer",
  providerRef: "computer",
  botId: "bot",
  kind: "docker",
};
const request = (runId: string): AgentRunRequest => ({
  botId: "bot",
  threadId: "thread",
  runId,
  prompt: "hello",
  instructions: "",
  history: [],
  tools: [],
  model: {
    provider: "openai-codex",
    id: "model",
    oauth: {
      credential: {
        type: "oauth" as const,
        access: "initial-access",
        refresh: "initial-refresh",
        expires: 1_000,
        accountId: "account",
      },
    },
  },
  execution: {
    choice: { harness: "codex-native" as const, targetId: "computer" },
    authority: { runId, attemptId: "attempt", fence: 1, policyRevision: 1 },
    continuity: { mode: "new" as const },
    computerId: "computer",
  },
});

const _unchangedSubscriptionAuth = async () =>
  new TextEncoder().encode(
    JSON.stringify({
      tokens: {
        access_token: "initial-access",
        refresh_token: "initial-refresh",
      },
    }),
  );

describe("CodexNativeRuntime", () => {
  it.each(["success", "arm", "start", "write", "return"])(
    "arms before launch and disarms on %s",
    async (outcome) => {
      const order: string[] = [];
      const process: NativeProcess = {
        write: async () => {
          if (outcome === "write") throw new Error("write failed");
        },
        stdout: (async function* () {
          yield '{"id":1,"result":{}}';
          yield '{"id":2,"result":{}}';
          yield '{"method":"mcpServer/startupStatus/updated","params":{"name":"rakazo","status":"ready"}}';
          yield '{"id":3,"result":{"thread":{"id":"thread"}}}';
          yield '{"id":4,"result":{}}';
          yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}';
        })(),
        stderr: (async function* () {})(),
        wait: async () => ({ code: 0 }),
        stop: async () => {
          order.push("stop");
          return "stopped";
        },
      };
      const runtime = new CodexNativeRuntime(
        {
          sandbox: {
            startNativeProcess: async () => {
              order.push("start");
              if (outcome === "start") throw new Error("start failed");
              return process;
            },
          } as unknown as SandboxProvider,
          computer,
          cwd: ".",
        },
        {
          toolServer: async () => ({
            ticket: "fixture-ticket",
            endpoint: {
              url: "http://rakazo-mcp/native-mcp",
              httpHeaders: { Authorization: "Bearer fixture-ticket" },
            },
            arm: async () => {
              order.push("arm");
              if (outcome === "arm") throw new Error("arm failed");
            },
            disarm: async () => {
              order.push("disarm");
            },
            close: async () => {
              order.push("close");
            },
          }),
        },
      );
      const run = (async () => {
        for await (const _event of runtime.run(request(`arm-${outcome}`), context)) {
          if (outcome === "return") break;
        }
      })();
      if (["arm", "start", "write"].includes(outcome))
        await expect(run).rejects.toThrow(`${outcome} failed`);
      else await run;
      expect(order[0]).toBe("arm");
      expect(order.filter((call) => call === "disarm")).toHaveLength(1);
      if (outcome === "arm") expect(order).toEqual(["arm", "disarm", "close"]);
      else expect(order.slice(0, 2)).toEqual(["arm", "start"]);
      if (outcome !== "success") expect(order.at(-1)).toBe("close");
      if (outcome === "success") await runtime.abort(`arm-${outcome}`);
    },
  );

  it.each([
    ...["ready", "starting", "failed", "cancelled", "missing", "unknown"].flatMap((status) => [
      { status, phase: "initialize", composed: true },
      { status, phase: "turn", composed: true },
    ]),
    { status: "failed", phase: "turn", composed: false },
  ])(
    "checks MCP startup status $status during $phase only when composed=$composed",
    async ({ status, phase, composed }) => {
      // Codex 0.154.0 McpServerStatusUpdatedNotification, with no private error detail exposed.
      const notification = JSON.stringify({
        method: "mcpServer/startupStatus/updated",
        params: {
          name: "rakazo",
          status: status === "unknown" ? "private-status-detail" : status,
          error: "private-error-detail",
          threadId: null,
        },
      });
      const process: NativeProcess = {
        write: async () => {},
        stdout: (async function* () {
          if (phase === "initialize" && status !== "missing") yield notification;
          yield '{"id":1,"result":{}}';
          yield '{"id":2,"result":{}}';
          yield '{"id":3,"result":{"thread":{"id":"thread"}}}';
          yield '{"id":4,"result":{}}';
          if (phase === "turn" && status !== "missing") yield notification;
          yield '{"method":"item/agentMessage/delta","params":{"delta":"OK"}}';
          yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}';
        })(),
        stderr: (async function* () {})(),
        wait: async () => ({ code: 0 }),
        stop: async () => "stopped",
      };
      const runtime = new CodexNativeRuntime(
        {
          sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
          computer,
          cwd: ".",
        },
        composed
          ? {
              toolServer: async () => ({
                ticket: "fixture-ticket",
                endpoint: {
                  url: "http://rakazo-mcp/native-mcp",
                  httpHeaders: { Authorization: "Bearer fixture-ticket" },
                },
                close: async () => {},
              }),
            }
          : {},
      );
      const events: AgentRuntimeEvent[] = [];
      const runId = `mcp-${status}-${phase}-${composed}`;
      const run = (async () => {
        for await (const event of runtime.run(request(runId), context)) events.push(event);
      })();
      const succeeds = status === "ready" || !composed;
      if (succeeds) await run;
      else await expect(run).rejects.toThrow(`codex MCP server rakazo is ${status}`);
      expect(events.some((event) => event.type === "done")).toBe(succeeds);
      expect(events.some((event) => event.type === "text")).toBe(succeeds);
      await runtime.abort(runId);
    },
  );

  it("fails an unrecognized server request during a turn instead of leaving the app-server blocked", async () => {
    const write = vi.fn(async () => undefined);
    const process: NativeProcess = {
      write,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"id":"server-request","method":"approval/request","params":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    await expect(
      (async () => {
        for await (const _event of runtime.run(request("unknown-server-request"), context))
          undefined;
      })(),
    ).rejects.toThrow("unsupported codex server request: approval/request");
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('"id":"server-request","error":{"code":-32601'),
    );
  });

  it("contains a durable expiry failure inside the timer callback", async () => {
    vi.useFakeTimers();
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const log = vi.spyOn(getLogger(), "error").mockImplementation(() => undefined);
    const runtime = new CodexNativeRuntime(
      {
        sandbox: {
          startNativeProcess: vi.fn().mockResolvedValue(process),
        } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      },
      {
        parkTtlMs: 1_000,
        onParkExpired: async () => {
          throw new Error("stale generation");
        },
      },
    );
    for await (const _event of runtime.run(request("expiry-error"), context)) undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toHaveBeenCalledWith("codex-native park expiry persistence failed");
    log.mockRestore();
    vi.useRealTimers();
  });

  it("keeps the default park TTL instead of reading the environment itself", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RAKAZO_NATIVE_PARK_TTL_MS", "1000");
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const expired = vi.fn(async () => undefined);
    const runtime = new CodexNativeRuntime(
      {
        sandbox: {
          startNativeProcess: vi.fn().mockResolvedValue(process),
        } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      },
      { onParkExpired: expired },
    );
    for await (const _event of runtime.run(request("default-ttl"), context)) undefined;
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expired).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("expires a parked process with an injected TTL and reconstructs the next turn", async () => {
    vi.useFakeTimers();
    const stopped = vi.fn(async () => "stopped" as const);
    const first: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: stopped,
    };
    const second: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const expired = vi.fn(async () => undefined);
    const runtime = new CodexNativeRuntime(
      {
        sandbox: {
          startNativeProcess: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
        } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      },
      { parkTtlMs: 1_000, onParkExpired: expired },
    );
    for await (const _event of runtime.run(request("ttl-first"), context)) undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toHaveBeenCalledOnce();
    expect(expired).toHaveBeenCalledWith({
      ref: { bindingId: "ttl-first", generation: 0 },
      processState: "stopped",
    });
    const resumed = request("ttl-second");
    resumed.execution!.continuity = {
      mode: "resume",
      ref: { bindingId: "ttl-first", generation: 0 },
      inputId: "next",
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(resumed, context)) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "native",
        event: expect.objectContaining({ type: "session", continuity: "reconstructed" }),
      }),
    );
    vi.useRealTimers();
  });

  it("does not expire a resumed turn with its previous parking TTL and rearms it when parked again", async () => {
    vi.useFakeTimers();
    let releaseResumedTurn!: () => void;
    const resumedTurn = new Promise<void>((resolve) => {
      releaseResumedTurn = resolve;
    });
    const stopped = vi.fn(async () => "stopped" as const);
    const write = vi.fn(async () => undefined);
    const process: NativeProcess = {
      write,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
        yield '{"id":5,"result":{}}\n';
        await resumedTurn;
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: stopped,
    };
    const expired = vi.fn(async () => undefined);
    const runtime = new CodexNativeRuntime(
      {
        sandbox: {
          startNativeProcess: vi.fn().mockResolvedValue(process),
        } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      },
      { parkTtlMs: 1_000, onParkExpired: expired },
    );
    const first = request("ttl-race-first");
    first.execution!.continuity = { mode: "new", ref: { bindingId: "ttl-race", generation: 0 } };
    for await (const _event of runtime.run(first, context)) undefined;

    const resumed = request("ttl-race-resumed");
    resumed.execution!.continuity = {
      mode: "resume",
      ref: { bindingId: "ttl-race", generation: 0 },
      inputId: "resume",
    };
    const running = (async () => {
      for await (const _event of runtime.run(resumed, context)) undefined;
    })();
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith(expect.stringContaining('"id":5')));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();

    releaseResumedTurn();
    await running;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopped).toHaveBeenCalledOnce();
    expect(expired).toHaveBeenCalledWith({
      ref: { bindingId: "ttl-race", generation: 0 },
      processState: "stopped",
    });
    vi.useRealTimers();
  });

  it("makes loss after an acknowledged turn start visible without replaying the turn", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 23 }),
      stop: async () => "stopped",
    };
    const startNativeProcess = vi.fn(async () => process);
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const events: AgentRuntimeEvent[] = [];

    await expect(
      (async () => {
        for await (const event of runtime.run(request("lost-after-start"), context))
          events.push(event);
      })(),
    ).rejects.toThrow(/turn outcome is uncertain/);

    expect(events).toContainEqual({
      type: "native",
      event: {
        type: "error",
        ref: { bindingId: "lost-after-start", generation: 0 },
        reason: "turn_outcome_uncertain",
      },
    });
    expect(events).toContainEqual({
      type: "native",
      event: {
        type: "closed",
        ref: { bindingId: "lost-after-start", generation: 0 },
        processState: "stopped",
      },
    });
    expect(startNativeProcess).toHaveBeenCalledTimes(1);
  });

  it("parks a completed native session and serves a resume on its original Codex thread", async () => {
    const writes: string[] = [];
    const process: NativeProcess = {
      id: "supervisor-native-session",
      write: async (data) => {
        writes.push(data);
      },
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
        yield '{"id":5,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const startNativeProcess = vi.fn(async () => process);
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const firstEvents = [];
    for await (const event of runtime.run(request("first-turn"), context)) firstEvents.push(event);
    const resumed = request("second-turn");
    resumed.execution!.continuity = {
      mode: "resume",
      ref: { bindingId: "first-turn", generation: 0 },
      inputId: "complement-1",
    };
    const resumedEvents = [];
    const reconstructedRuntime = new CodexNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    for await (const event of reconstructedRuntime.run(resumed, context)) resumedEvents.push(event);

    expect(startNativeProcess).toHaveBeenCalledTimes(1);
    expect(firstEvents).toContainEqual({
      type: "native",
      event: {
        type: "session",
        ref: { bindingId: "first-turn", generation: 0 },
        continuity: "new",
        processRef: "supervisor-native-session",
      },
    });
    expect(resumedEvents).toContainEqual({
      type: "native",
      event: {
        type: "session",
        ref: { bindingId: "first-turn", generation: 0 },
        continuity: "resumed",
        processRef: "supervisor-native-session",
      },
    });
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({
      id: 5,
      method: "turn/start",
      params: { threadId: "native-thread", input: [{ type: "text", text: "hello" }] },
    });
  });

  it("feeds the Rakazo thread history to a new native session and never to a resumed one", async () => {
    const writes: string[] = [];
    const process: NativeProcess = {
      id: "supervisor-history-session",
      write: async (data) => {
        writes.push(data);
      },
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
        yield '{"id":5,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const history: AgentRunRequest["history"] = [
      { role: "user", content: "the launch code word is mimosa" },
      { role: "assistant", content: "Noted, the code word is mimosa." },
    ];
    for await (const _event of runtime.run({ ...request("history-first"), history }, context))
      undefined;
    const turnText = (line: string) =>
      (JSON.parse(line) as { params: { input: Array<{ text: string }> } }).params.input[0]!.text;
    const newTurn = turnText(writes.find((line) => line.includes('"turn/start"'))!);
    expect(newTurn).toContain("the launch code word is mimosa");
    expect(newTurn).toContain("Noted, the code word is mimosa.");
    expect(newTurn).toContain("hello");

    const resumed = { ...request("history-second"), history };
    resumed.execution!.continuity = {
      mode: "resume",
      ref: { bindingId: "history-first", generation: 0 },
      inputId: "complement-1",
    };
    for await (const _event of runtime.run(resumed, context)) undefined;
    expect(turnText(writes.at(-1)!)).toBe("hello");
  });

  it("clears a stopped parked session only through the test-only registry seam", async () => {
    const stopped = vi.fn(async () => "stopped" as const);
    const writes: string[] = [];
    const first: NativeProcess = {
      id: "parked-process",
      write: async (data) => {
        writes.push(data);
      },
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: stopped,
    };
    const second: NativeProcess = {
      id: "reconstructed-process",
      write: async (data) => {
        writes.push(data);
      },
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped" as const,
    };
    const startNativeProcess = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const initial = request("registry-reset-initial");
    initial.execution!.continuity = {
      mode: "new",
      ref: { bindingId: "registry-reset", generation: 0 },
    };
    for await (const _event of runtime.run(initial, context)) undefined;

    const verifyStopped = vi.fn(async (processRef: string) => {
      expect(processRef).toBe("parked-process");
    });
    await stopAndClearParkedCodexRuntimeForTest({
      computer,
      ref: { bindingId: "registry-reset", generation: 0 },
      verifyStopped,
    });

    expect(stopped).toHaveBeenCalledOnce();
    expect(verifyStopped).toHaveBeenCalledWith("parked-process");
    const resumed = request("registry-reset-reconstructed");
    resumed.execution!.continuity = {
      mode: "resume",
      ref: { bindingId: "registry-reset", generation: 0 },
      inputId: "followup",
      nativeRef: "native-thread",
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(resumed, context)) events.push(event);
    expect(startNativeProcess).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "native",
        event: expect.objectContaining({ type: "session", continuity: "reconstructed" }),
      }),
    );
    expect(writes.map((write) => JSON.parse(write).method)).toContain("thread/resume");
    const homes = startNativeProcess.mock.calls.map(
      ([, nativeRequest]) => (nativeRequest as { env?: Record<string, string> }).env?.CODEX_HOME,
    );
    expect(homes).toHaveLength(2);
    expect(homes[0]).toMatch(/^\/tmp\/rakazo-codex-bot-[a-f0-9]{64}$/);
    expect(homes[1]).toBe(homes[0]);
  });

  it("signals an unavailable rollout when reconstruction follows Computer loss", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"error":{"code":-32600,"message":"no rollout found"}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const runtime = new CodexNativeRuntime({
      sandbox: {
        startNativeProcess: vi.fn().mockResolvedValue(process),
      } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const reconstructed = request("lost-computer");
    reconstructed.execution!.continuity = {
      mode: "reconstruct",
      previous: { bindingId: "lost-binding", generation: 0 },
      reason: "parked_process_missing",
      inputId: "next-turn",
      nativeRef: "lost-native-thread",
    };
    const events: AgentRuntimeEvent[] = [];
    await expect(
      (async () => {
        for await (const event of runtime.run(reconstructed, context)) events.push(event);
      })(),
    ).rejects.toMatchObject({
      code: "harness_unavailable",
      message: "codex_native_rollout_missing",
    });
    expect(events).toContainEqual({
      type: "native",
      event: {
        type: "error",
        ref: { bindingId: "lost-binding", generation: 0 },
        reason: "resume_rollout_missing",
      },
    });
  });

  it("refuses to resume a parked session from a different Computer placement", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"native-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
        yield '{"id":5,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const startNativeProcess = vi.fn(async () => process);
    const original = new CodexNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    for await (const _event of original.run(request("isolated-turn"), context)) undefined;

    const otherComputer = { ...computer, id: "other-computer", botId: "other-bot" };
    const otherPlacement = new CodexNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer: otherComputer,
      cwd: ".",
    });
    const resumed = request("other-placement-turn");
    resumed.botId = "other-bot";
    resumed.execution!.continuity = {
      mode: "resume",
      ref: { bindingId: "isolated-turn", generation: 0 },
      inputId: "cross-placement",
    };

    await expect(
      (async () => {
        for await (const _event of otherPlacement.run(resumed, {
          ...context,
          botId: "other-bot",
        }))
          undefined;
      })(),
    ).rejects.toMatchObject({ code: "harness_unavailable" });
    expect(startNativeProcess).toHaveBeenCalledTimes(1);
  });

  it("composes a supplied HTTP MCP server into the native process without exposing its bearer in argv or env", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"method":"mcpServer/startupStatus/updated","params":{"name":"rakazo","status":"ready"}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const startNativeProcess = vi.fn<
      (computer: ComputerRef, request: unknown, context: AdapterContext) => Promise<NativeProcess>
    >(async () => process);
    const toolServer = vi.fn(async () => ({
      endpoint: {
        url: "http://rakazo-mcp/native-mcp",
        httpHeaders: { Authorization: "Bearer ticket-must-stay-private" },
      },
      ticket: "ticket-must-stay-private",
      close: vi.fn(async () => undefined),
    }));
    const runtime = new CodexNativeRuntime(
      { sandbox: { startNativeProcess } as unknown as SandboxProvider, computer, cwd: "." },
      { toolServer },
    );

    for await (const _event of runtime.run(request("mcp-composed"), context)) undefined;

    expect(runtime.describe().capabilities.tools).toBe(true);
    expect(toolServer).toHaveBeenCalledWith(request("mcp-composed"));
    expect(startNativeProcess).toHaveBeenCalledWith(
      computer,
      expect.objectContaining({
        files: [
          expect.objectContaining({
            path: "config.toml",
            content: expect.stringContaining('url = "http://rakazo-mcp/native-mcp"'),
          }),
        ],
      }),
      context,
    );
    const nativeRequest = startNativeProcess.mock.calls[0]![1] as {
      argv: string[];
      env?: Record<string, string>;
      files?: Array<{ content: string }>;
    };
    expect(nativeRequest.argv.join(" ")).not.toContain("ticket-must-stay-private");
    expect(JSON.stringify(nativeRequest.env)).not.toContain("ticket-must-stay-private");
    expect(nativeRequest.files?.[0]?.content).toContain(
      'http_headers = { Authorization = "Bearer ticket-must-stay-private" }',
    );
  });

  it("leaves MCP unconfigured when no tool server is supplied", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"method":"mcpServer/startupStatus/updated","params":{"name":"rakazo","status":"ready"}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const startNativeProcess = vi.fn(async () => process);
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    for await (const _event of runtime.run(request("without-mcp"), context)) undefined;

    expect(runtime.describe().capabilities.tools).toBe(false);
    expect(startNativeProcess).toHaveBeenCalledWith(
      computer,
      expect.not.objectContaining({ files: expect.anything() }),
      context,
    );
  });

  it("closes the MCP server after stopping the native process when the turn fails", async () => {
    const order: string[] = [];
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"method":"mcpServer/startupStatus/updated","params":{"name":"rakazo","status":"ready"}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"interrupted"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => {
        order.push("stop");
        return "stopped";
      },
    };
    const close = vi.fn(async () => {
      order.push("close");
    });
    const runtime = new CodexNativeRuntime(
      {
        sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      },
      {
        toolServer: async () => ({
          endpoint: { command: "rakazo-mcp-relay", args: [] },
          ticket: "private-ticket",
          close,
        }),
      },
    );

    await expect(
      (async () => {
        for await (const _event of runtime.run(request("mcp-error"), context)) undefined;
      })(),
    ).rejects.toThrow(/non-success status: interrupted/);

    expect(order).toEqual(["stop", "close"]);
  });

  it("answers a correlated external refresh with the refreshed subscription token", async () => {
    const write = vi.fn(async () => undefined);
    const process: NativeProcess = {
      write,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"id":"refresh-1","method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized"}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const refresh = vi.fn(async () => ({
      type: "oauth" as const,
      access: "refreshed",
      refresh: "rotated",
      expires: 2_000,
      accountId: "account",
    }));
    const persist = vi.fn(async () => undefined);
    const runtime = new CodexNativeRuntime({
      sandbox: {
        startNativeProcess: async () => process,
      } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const input = request("refresh");
    if (!input.model.oauth) throw new Error("OAuth request fixture is malformed");
    input.model.oauth.refresh = refresh;
    input.model.oauth.persist = persist;
    for await (const _ of runtime.run(input, context)) undefined;
    expect(refresh).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(
        '"id":"refresh-1","result":{"accessToken":"refreshed","chatgptAccountId":"account"}',
      ),
    );
  });

  it("signals an unconfirmed stop when closing a parked native session", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stop_unconfirmed",
    };
    const runtime = new CodexNativeRuntime({
      sandbox: {
        startNativeProcess: async () => process,
      } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const parked = request("cleanup");
    parked.execution!.continuity = { mode: "new", ref: { bindingId: "thread", generation: 0 } };
    for await (const _ of runtime.run(parked, context)) undefined;
    await expect(runtime.abort("cleanup")).rejects.toThrow(/stop was not confirmed/);
  });

  it("bridges only the selected ChatGPT subscription into an isolated Codex home and persists a refresh", async () => {
    const writes: string[] = [];
    const write = async (data: string) => {
      writes.push(data);
    };
    const process: NativeProcess = {
      write,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{"type":"chatgptAuthTokens"}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const startNativeProcess = vi.fn(async () => process);
    const sandbox = {
      startNativeProcess,
    } as unknown as SandboxProvider;
    const persist = vi.fn(async () => undefined);
    const runtime = new CodexNativeRuntime({ sandbox, computer, cwd: "." });
    const oauthRequest = {
      ...request("subscription"),
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-test",
        thinkingLevel: "medium" as const,
        oauth: {
          credential: {
            type: "oauth" as const,
            access: "initial-access",
            refresh: "initial-refresh",
            expires: 1_000,
            accountId: "account",
          },
          persist,
        },
      },
    };

    for await (const _event of runtime.run(oauthRequest, context)) undefined;

    expect(startNativeProcess).toHaveBeenCalledWith(
      computer,
      expect.objectContaining({
        privateHome: expect.stringMatching(/^\/tmp\/rakazo-codex-bot-[a-f0-9]{64}$/),
        env: expect.objectContaining({
          OPENAI_API_KEY: "",
          CODEX_HOME: expect.stringMatching(/^\/tmp\/rakazo-codex-bot-[a-f0-9]{64}$/),
        }),
      }),
      context,
    );
    expect(persist).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0]!)).toMatchObject({
      id: 1,
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    expect(JSON.parse(writes[2]!)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "account/login/start",
      params: {
        type: "chatgptAuthTokens",
        accessToken: "initial-access",
        chatgptAccountId: "account",
      },
    });
    expect(JSON.parse(writes[3]!)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "thread/start",
      params: {},
    });
    expect(JSON.parse(writes[4]!)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      method: "turn/start",
      params: {
        threadId: "thread",
        input: [{ type: "text", text: "hello" }],
        model: "gpt-5.6-test",
        effort: "medium",
      },
    });
  });

  it.each([
    { mode: "new", method: "thread/start", params: {} },
    { mode: "reconstruct", method: "thread/resume", params: { threadId: "stored-thread" } },
  ])("gives the bot instructions to Codex on $method", async ({ mode, method, params }) => {
    const writes: string[] = [];
    const process: NativeProcess = {
      write: async (data) => {
        writes.push(data);
      },
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"stored-thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const instructed = { ...request(`instructions-${mode}`), instructions: "Use remember." };
    if (mode === "reconstruct")
      instructed.execution!.continuity = {
        mode: "reconstruct",
        previous: { bindingId: "instructions-binding", generation: 0 },
        reason: "parked_process_missing",
        inputId: "next",
        nativeRef: "stored-thread",
      };
    for await (const _event of runtime.run(instructed, context)) undefined;
    const thread = writes.map((write) => JSON.parse(write)).find((rpc) => rpc.id === 3);
    expect(thread).toMatchObject({
      method,
      params: { ...params, developerInstructions: "Use remember." },
    });
    expect(thread.params).not.toHaveProperty("baseInstructions");
    await runtime.abort(`instructions-${mode}`);
  });

  it("uses the private Computer workspace root instead of rejecting its empty relative cwd", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const startNativeProcess = vi.fn(async () => process);
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: "",
    });

    for await (const _event of runtime.run(request("private-root"), context)) undefined;

    expect(startNativeProcess).toHaveBeenCalledWith(
      computer,
      expect.objectContaining({ cwd: "" }),
      context,
    );
  });

  it("uses the Computer-native process and accepts only the schema completed status", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","items":[],"status":"completed"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const sandbox = {
      startNativeProcess: async () => process,
    } as unknown as SandboxProvider;
    const runtime = new CodexNativeRuntime({ sandbox, computer, cwd: "." });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request("success"), context)) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("rejects the schema interrupted turn status", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
        yield '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","items":[],"status":"interrupted"}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const sandbox = {
      startNativeProcess: async () => process,
    } as unknown as SandboxProvider;
    const runtime = new CodexNativeRuntime({ sandbox, computer, cwd: "." });
    await expect(
      (async () => {
        for await (const _event of runtime.run(request("interrupted"), context)) undefined;
      })(),
    ).rejects.toThrow(/non-success status: interrupted/);
  });

  it("reports uncertainty when the app-server ends after turn/start without turn/completed", async () => {
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"id":1,"result":{}}\n';
        yield '{"id":2,"result":{}}\n';
        yield '{"id":3,"result":{"thread":{"id":"thread"}}}\n';
        yield '{"id":4,"result":{}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 23 }),
      stop: async () => "stopped",
    };
    const runtime = new CodexNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events: AgentRuntimeEvent[] = [];
    await expect(
      (async () => {
        for await (const event of runtime.run(request("ends-before-completion"), context))
          events.push(event);
      })(),
    ).rejects.toThrow(/turn outcome is uncertain/);
    expect(events).toContainEqual({
      type: "native",
      event: {
        type: "error",
        ref: { bindingId: "ends-before-completion", generation: 0 },
        reason: "turn_outcome_uncertain",
      },
    });
  });
});
