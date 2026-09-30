import type {
  AdapterContext,
  ComputerRef,
  NativeProcess,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditSandbox,
  cidrsOverlap,
  classifyNativeProbeFailure,
  classifyRuntimeFailure,
  cleanupDedicatedDockerResources,
  createNativeProbeRequest,
  finishOAuthAfterReady,
  isJ2ScriptedCoordinatorRun,
  isJ2WorkReturnWakePrompt,
  j2WakeScriptedResponse,
  j2WorkReturnText,
  throwReplayFailure,
  waitForOAuthReady,
  waitForSpecialistReturnDelivery,
  waitForTerminalRun,
  withFreshOperationSignal,
} from "./t01-live-subscription.ts";

afterEach(() => vi.useRealTimers());

const auditContext: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};
const auditComputer: ComputerRef = {
  id: "computer",
  providerRef: "computer",
  botId: "bot",
  kind: "docker",
};

describe("T01 live OAuth wait", () => {
  it("uses the provider expiration when it is sooner than the local bound", async () => {
    vi.useFakeTimers();
    let received!: AbortSignal;
    const waiting = waitForOAuthReady(
      async (signal) => {
        received = signal;
        return { status: "pending" };
      },
      1,
      {
        localTimeoutMs: 60_000,
        delay: (signal) =>
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      },
    );

    const rejected = expect(waiting).rejects.toThrow(
      "OAuth device code expired before sign-in completed.",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    expect(received.aborted).toBe(true);
  });

  it("propagates caller cancellation into the in-flight completion wait", async () => {
    const controller = new AbortController();
    let received!: AbortSignal;
    const waiting = waitForOAuthReady(
      async (signal) => {
        received = signal;
        return { status: "pending" };
      },
      900,
      {
        signal: controller.signal,
        delay: (signal) =>
          new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      },
    );

    controller.abort(new Error("cancelled by operator"));

    await expect(waiting).rejects.toThrow("cancelled by operator");
    expect(received.aborted).toBe(true);
  });

  it("finishes a ready sign-in after the provision signal has expired", async () => {
    vi.useFakeTimers();
    const provision = new AbortController();
    setTimeout(() => provision.abort(new Error("provision deadline exceeded")), 120_000);
    await vi.advanceTimersByTimeAsync(12 * 60 * 1000);
    let finishSignal!: AbortSignal;
    const finishing = finishOAuthAfterReady(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          finishSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      120_000,
    );
    expect(provision.signal.aborted).toBe(true);
    expect(finishSignal.aborted).toBe(false);
    const finishRejected = expect(finishing).rejects.toThrow("T01 operation timed out.");
    await vi.advanceTimersByTimeAsync(120_000);
    await finishRejected;

    let cleanupSignal!: AbortSignal;
    const cleaning = withFreshOperationSignal(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          cleanupSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      120_000,
    );
    expect(cleanupSignal.aborted).toBe(false);
    const cleanupRejected = expect(cleaning).rejects.toThrow("T01 operation timed out.");
    await vi.advanceTimersByTimeAsync(120_000);
    await cleanupRejected;
  });
});

describe("T01 native failure receipt", () => {
  it("keeps only the delegated run result in the bounded J2 receipt", () => {
    expect(
      j2WorkReturnText(
        [
          { runId: "other-run", blocks: [{ kind: "text", text: "ignore" }] },
          {
            runId: "delegated-run",
            blocks: [
              { kind: "text", text: "first result" },
              { kind: "tool", name: "ignored" },
              { kind: "text", text: "second result" },
            ],
          },
        ],
        "delegated-run",
      ),
    ).toBe("first result second result");
  });

  it("selects the J2 scripted runtime only for the dispatch-time coordinator identity", () => {
    expect(isJ2ScriptedCoordinatorRun("coordinator-1", "coordinator-1")).toBe(true);
    expect(isJ2ScriptedCoordinatorRun("specialist-1", "coordinator-1")).toBe(false);
  });

  it("acknowledges an auth-free J2 work-return wake without producing a tool", () => {
    const response = j2WakeScriptedResponse("UNTRUSTED SPECIALIST OUTPUT");

    expect(isJ2WorkReturnWakePrompt("UNTRUSTED SPECIALIST OUTPUT")).toBe(true);
    expect(isJ2WorkReturnWakePrompt("J2 delegate start")).toBe(false);
    expect(response).toEqual({ type: "done", text: "J2 wake acknowledged" });
    expect(response).not.toHaveProperty("name");
  });

  it("waits for a coordinator wake to become terminal", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValue({ status: "completed" });

    await expect(
      waitForTerminalRun(read, {
        delay: async () => undefined,
        now: (() => 0) as () => number,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("waits for the transactional specialist return after the Run first becomes terminal", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", terminalReturnDelivery: null })
      .mockResolvedValue({
        status: "failed",
        terminalReturnDelivery: "delivered",
      });

    await expect(
      waitForSpecialistReturnDelivery(read, {
        delay: async () => undefined,
        now: (() => 0) as () => number,
      }),
    ).resolves.toMatchObject({ terminalReturnDelivery: "delivered" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("builds an auth-free runtime probe request with a structurally fake credential", () => {
    const request = createNativeProbeRequest({
      botId: "probe-bot",
      computerId: "probe-computer",
      runId: "probe-run",
    });

    expect(request.execution?.choice).toEqual({
      harness: "codex-native",
      targetId: "probe-computer",
    });
    expect(request.model.oauth?.credential).toMatchObject({
      type: "oauth",
      access: "probe-not-a-jwt",
      accountId: "probe",
    });
    expect(request.model.oauth?.credential.access).not.toMatch(/^eyJ/);
    expect(classifyNativeProbeFailure(new Error("failed to set external auth"))).toBe(
      "expected_fake_auth_rejection",
    );
    expect(
      classifyNativeProbeFailure(new Error("codex app-server ended before response (exit code 0)")),
    ).toBe("ended_before_initialize_response");
  });

  it("emits the bounded replay receipt before rethrowing the replay failure", () => {
    const write = vi.fn();
    const failure = new Error("Native replay run failed");

    expect(() =>
      throwReplayFailure(
        [
          "PUBLIC_RUN_STATUS=failed",
          "RUNTIME_FAILURE_CATEGORY=process_ended_before_turn_completion",
        ],
        failure,
        write,
      ),
    ).toThrow(failure);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      "PUBLIC_RUN_STATUS=failed\nRUNTIME_FAILURE_CATEGORY=process_ended_before_turn_completion",
    );
  });

  it("records a login RPC error by method and code without recording its message", async () => {
    const receipt: string[] = [];
    const write = vi.fn(async () => undefined);
    const process: NativeProcess = {
      write,
      stdout: (async function* () {
        yield '{"jsonrpc":"2.0","id":2,"error":{"code":-32600,"message":"synthetic secret-free detail"}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 1 }),
      stop: async () => "stopped",
    };
    const audited = auditSandbox(
      { startNativeProcess: async () => process } as unknown as SandboxProvider,
      receipt,
    );
    const native = await audited.startNativeProcess!(
      auditComputer,
      { argv: ["codex"] },
      auditContext,
    );
    await native.write(
      '{"jsonrpc":"2.0","id":2,"method":"account/login/start","params":{"redacted":true}}\n',
    );
    for await (const _ of native.stdout) undefined;

    expect(receipt).toEqual([
      "NATIVE_OUTBOUND_METHOD=account/login/start",
      "NATIVE_RPC_ERROR_METHOD=account/login/start CODE=-32600",
      "NATIVE_AGENT_MESSAGE_DELTAS=0",
      "LAST_NATIVE_NOTIFICATION=none",
    ]);
  });

  it("records a thread/resume request so a reconstruction is provable", async () => {
    const receipt: string[] = [];
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {})(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const audited = auditSandbox(
      { startNativeProcess: async () => process } as unknown as SandboxProvider,
      receipt,
    );
    const native = await audited.startNativeProcess!(
      auditComputer,
      { argv: ["codex"] },
      auditContext,
    );
    await native.write(
      '{"jsonrpc":"2.0","id":3,"method":"thread/resume","params":{"threadId":"synthetic-thread"}}\n',
    );

    expect(receipt).toContain("NATIVE_OUTBOUND_METHOD=thread/resume");
  });

  it("records a redacted RPC detail for a thread method", async () => {
    const receipt: string[] = [];
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"jsonrpc":"2.0","id":3,"error":{"code":-32600,"message":"thread unavailable at https://example.test/diagnostic"}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 1 }),
      stop: async () => "stopped",
    };
    const audited = auditSandbox(
      { startNativeProcess: async () => process } as unknown as SandboxProvider,
      receipt,
    );
    const native = await audited.startNativeProcess!(
      auditComputer,
      { argv: ["codex"] },
      auditContext,
    );
    await native.write('{"jsonrpc":"2.0","id":3,"method":"thread/start","params":{}}\n');
    for await (const _ of native.stdout) undefined;

    expect(receipt).toEqual([
      "NATIVE_OUTBOUND_METHOD=thread/start",
      "NATIVE_RPC_ERROR_METHOD=thread/start CODE=-32600",
      "NATIVE_RPC_ERROR_CATEGORY=invalid_request",
      "NATIVE_RPC_ERROR_MESSAGE=thread unavailable at <url>",
      "NATIVE_AGENT_MESSAGE_DELTAS=0",
      "LAST_NATIVE_NOTIFICATION=none",
    ]);
  });

  it.each([
    [{ code: 23 }, "23"],
    [{ code: null }, "unknown"],
  ])("records only an allowlisted terminal code (%s)", async (outcome, expectedCode) => {
    const receipt: string[] = [];
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"jsonrpc":"2.0","method":"turn/started","params":{"secret":"must-not-appear"}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => outcome,
      stop: async () => "stopped",
    };
    const audited = auditSandbox(
      {
        startNativeProcess: async () => process,
      } as unknown as SandboxProvider,
      receipt,
    );
    const native = await audited.startNativeProcess!(
      auditComputer,
      { argv: ["codex"] },
      auditContext,
    );
    for await (const _ of native.stdout) undefined;
    await native.wait();

    expect(receipt).toEqual([
      "NATIVE_EVENT=turn/started",
      "NATIVE_AGENT_MESSAGE_DELTAS=0",
      "LAST_NATIVE_NOTIFICATION=turn/started",
      `NATIVE_PROCESS_EXIT_CODE=${expectedCode}`,
      "NATIVE_PROCESS_EXIT_SOURCE=unknown",
    ]);
    expect(receipt.join("\n")).not.toContain("must-not-appear");
  });

  it("records only bounded native diagnostics facts, never fixture stderr or turn payload", async () => {
    const receipt: string[] = [];
    const secretMarker = "stderr-secret-marker-never-returned";
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"jsonrpc":"2.0","id":4,"result":{"turn":{"status":"inProgress","secret":"never-returned"}}}\n';
      })(),
      stderr: (async function* () {
        yield secretMarker;
      })(),
      wait: async () => ({
        code: 0,
        exitSource: "wrapper_exit_file",
        stderr: { present: true, category: "unknown" },
      }),
      stop: async () => "stopped",
    };
    const audited = auditSandbox(
      { startNativeProcess: async () => process } as unknown as SandboxProvider,
      receipt,
    );
    const native = await audited.startNativeProcess!(
      auditComputer,
      { argv: ["codex"] },
      auditContext,
    );
    await native.write('{"jsonrpc":"2.0","id":4,"method":"turn/start","params":{}}\n');
    for await (const _ of native.stdout) undefined;
    await native.wait();

    expect(receipt).toEqual([
      "NATIVE_OUTBOUND_METHOD=turn/start",
      "NATIVE_RESPONSE_METHOD=turn/start",
      "NATIVE_TURN_START_STATUS=inProgress",
      "NATIVE_AGENT_MESSAGE_DELTAS=0",
      "LAST_NATIVE_NOTIFICATION=none",
      "NATIVE_PROCESS_EXIT_CODE=0",
      "NATIVE_PROCESS_EXIT_SOURCE=wrapper_exit_file",
      "NATIVE_STDERR_PRESENT=yes",
      "NATIVE_STDERR_CATEGORY=unknown",
    ]);
    expect(receipt.join("\n")).not.toContain(secretMarker);
    expect(receipt.join("\n")).not.toContain("never-returned");
  });

  it("records post-login native stages and only allowlisted failure categories", async () => {
    const receipt: string[] = [];
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"jsonrpc":"2.0","id":3,"result":{"thread":{"id":"synthetic-thread"}}}\n';
        yield '{"jsonrpc":"2.0","id":4,"result":{"turn":{"id":"synthetic-turn"}}}\n';
        yield '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"synthetic-thread","turn":{"id":"synthetic-turn","items":[],"status":"inProgress"}}}\n';
        yield '{"jsonrpc":"2.0","method":"error","params":{"threadId":"synthetic-thread","turnId":"synthetic-turn","willRetry":false,"error":{"message":"do not retain this text","codexErrorInfo":"usageLimitExceeded"}}}\n';
        yield '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"synthetic-thread","turn":{"id":"synthetic-turn","items":[],"status":"failed","error":{"message":"do not retain this text","codexErrorInfo":"usageLimitExceeded"}}}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 1 }),
      stop: async () => "stopped",
    };
    const audited = auditSandbox(
      { startNativeProcess: async () => process } as unknown as SandboxProvider,
      receipt,
    );
    const native = await audited.startNativeProcess!(
      auditComputer,
      { argv: ["codex"] },
      auditContext,
    );
    await native.write('{"jsonrpc":"2.0","id":3,"method":"thread/start","params":{}}\n');
    await native.write(
      '{"jsonrpc":"2.0","id":4,"method":"turn/start","params":{"threadId":"synthetic-thread","input":[]}}\n',
    );
    for await (const _ of native.stdout) undefined;

    expect(receipt).toEqual([
      "NATIVE_OUTBOUND_METHOD=thread/start",
      "NATIVE_OUTBOUND_METHOD=turn/start",
      "NATIVE_RESPONSE_METHOD=thread/start",
      "NATIVE_RESPONSE_METHOD=turn/start",
      "NATIVE_TURN_START_STATUS=unknown",
      "NATIVE_EVENT=turn/started",
      "NATIVE_EVENT=error",
      "NATIVE_ERROR_CATEGORY=usageLimitExceeded",
      "NATIVE_TURN_COMPLETED_STATUS=failed",
      "NATIVE_TURN_ERROR_CATEGORY=usageLimitExceeded",
      "NATIVE_AGENT_MESSAGE_DELTAS=0",
      "LAST_NATIVE_NOTIFICATION=turn/completed",
    ]);
  });

  it("counts agent message deltas without retaining their content", async () => {
    const receipt: string[] = [];
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"never-retained"}}\n';
        yield '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"still-never-retained"}}\n';
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 0 }),
      stop: async () => "stopped",
    };
    const audited = auditSandbox(
      { startNativeProcess: async () => process } as unknown as SandboxProvider,
      receipt,
    );
    const native = await audited.startNativeProcess!(
      auditComputer,
      { argv: ["codex"] },
      auditContext,
    );
    for await (const _ of native.stdout) undefined;

    expect(receipt).toEqual([
      "NATIVE_AGENT_MESSAGE_DELTAS=2",
      "LAST_NATIVE_NOTIFICATION=item/agentMessage/delta",
    ]);
    expect(receipt.join("\n")).not.toContain("never-retained");
  });

  it("classifies stored runtime failures without retaining their messages", () => {
    expect(classifyRuntimeFailure("codex thread/start response missing native thread id")).toBe(
      "thread_start_missing_id",
    );
    expect(classifyRuntimeFailure("unexpected untrusted diagnostic")).toBe("unclassified");
    expect(classifyRuntimeFailure("codex account login was refused")).toBe("authentication");
  });
});

describe("T01 dedicated Docker subnet selection", () => {
  it("rejects a candidate contained by an existing host route", () => {
    expect(cidrsOverlap("10.254.0.0/24", "10.254.0.0/16")).toBe(true);
  });

  it("accepts a candidate disjoint from a host route", () => {
    expect(cidrsOverlap("10.254.0.0/24", "172.31.0.0/16")).toBe(false);
  });
});

describe("T01 dedicated Docker cleanup", () => {
  it("records a failed container removal and continues to network cleanup", () => {
    const steps: string[] = [];

    const errors = cleanupDedicatedDockerResources({
      containerName: "t01-container",
      networkName: "t01-network",
      removeContainer: () => {
        steps.push("container");
        throw new Error("Docker unavailable");
      },
      networkExists: () => {
        steps.push("network inspected");
        return true;
      },
      removeNetwork: () => steps.push("network removed"),
    });

    expect(errors).toEqual(["dedicated container cleanup failed"]);
    expect(steps).toEqual(["container", "network inspected", "network removed"]);
  });
});
