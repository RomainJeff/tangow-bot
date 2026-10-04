import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ComputerRef,
  NativeProcess,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { promptWithThreadHistory } from "./native-history.js";
import type { NativeToolServer } from "./rakazo-mcp-server.js";
export class HarnessUnavailableError extends Error {
  readonly code = "harness_unavailable";
}

class NativeMcpUnavailableError extends HarnessUnavailableError {}

type Rpc = {
  id?: string | number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  params?: Record<string, unknown>;
};

class NativeRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcCode: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

export type NativeToolServerProvider = (attempt: AgentRunRequest) => Promise<NativeToolServer>;

type ParkedSession = {
  process: NativeProcess;
  lines: AsyncIterator<string>;
  threadId: string;
  toolServer?: NativeToolServer;
  expiry?: ReturnType<typeof setTimeout>;
};

type NativeParkExpiry = (input: {
  ref: { bindingId: string; generation: number };
  processState: "stopped" | "stop_unconfirmed";
}) => Promise<void>;

function parkTtlMs(value = 15 * 60_000): number {
  return Math.min(Math.max(value, 1_000), 60 * 60_000);
}

function mcpConfig(server: NativeToolServer): string {
  const quote = (value: string) => JSON.stringify(value);
  if ("url" in server.endpoint) {
    return [
      "[mcp_servers.rakazo]",
      // Verified against codex-cli 0.154.0's TOML config parser.
      `url = ${quote(server.endpoint.url)}`,
      `http_headers = { ${Object.entries(server.endpoint.httpHeaders)
        .map(([key, value]) => `${key} = ${quote(value)}`)
        .join(", ")} }`,
      "",
    ].join("\n");
  }
  const env = { ...server.endpoint.env, RAKAZO_MCP_TICKET: server.ticket };
  return [
    "[mcp_servers.rakazo]",
    `command = ${quote(server.endpoint.command)}`,
    `args = [${server.endpoint.args.map(quote).join(", ")}]`,
    `env = { ${Object.entries(env)
      .map(([key, value]) => `${key} = ${quote(value)}`)
      .join(", ")} }`,
    "",
  ].join("\n");
}

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { code: "harness_unavailable" });
}

function nativeHomeForBinding(botId: string, bindingId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId))
    throw unavailable("codex-native requires a safe Computer bot identity");
  const bindingHash = createHash("sha256").update(bindingId).digest("hex");
  return `/tmp/rakazo-codex-${botId}-${bindingHash}`;
}

/** Codex app-server runtime whose process can only live in its selected Computer. */
export class CodexNativeRuntime implements AgentRuntime {
  private static readonly active = new Map<string, NativeProcess>();
  /** Confirmed processes retained briefly so durable close can authorize home deletion. */
  private static readonly stopped = new Map<string, NativeProcess>();
  /**
   * A completed Codex turn is a verified quiescence boundary.  The app-server
   * stays in its Computer, with stdio open, until an explicit abort closes it.
   * The key is the public binding/generation rather than Codex's thread id.
   */
  private static readonly parked = new Map<string, ParkedSession>();
  /** Links a run to its durable binding while the session is parked. */
  private static readonly parkedBindingByRun = new Map<string, string>();

  constructor(
    private readonly placement: {
      sandbox: SandboxProvider;
      computer: ComputerRef;
      cwd: string;
    },
    private readonly options: {
      toolServer?: NativeToolServerProvider;
      onParkExpired?: NativeParkExpiry;
      parkTtlMs?: number;
    } = {},
  ) {}

  /**
   * Parking can be resolved by a recreated runtime, but never across the
   * authority boundary of the Computer placement that owns the process.
   */
  private placementKey(): string {
    return `${this.placement.computer.botId}:${this.placement.computer.id}`;
  }

  describe() {
    return {
      id: "codex-native",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        streaming: true,
        compaction: false,
        tools: this.options.toolServer !== undefined,
        scripted: false,
      },
    };
  }

  /**
   * Testkit-only loss simulation. It refuses non-test callers and preserves
   * the parked registry until the caller has proved the stopped process is
   * absent from the Computer. Product recovery never calls this path.
   */
  static async stopAndClearParkedSessionForTest(input: {
    computer: ComputerRef;
    ref: { bindingId: string; generation: number };
    verifyStopped: (processRef: string) => Promise<void>;
  }): Promise<void> {
    if (process.env.NODE_ENV !== "test")
      throw new Error("Codex parked registry clearing is test-only");
    const placementKey = `${input.computer.botId}:${input.computer.id}`;
    const bindingKey = `${placementKey}:${input.ref.bindingId}:${input.ref.generation}`;
    const parked = CodexNativeRuntime.parked.get(bindingKey);
    if (!parked?.process.id) throw new Error("Codex parked process cannot be proved stopped");
    const status = await parked.process.stop();
    if (status !== "stopped")
      throw new HarnessUnavailableError("codex-native stop was not confirmed");
    await input.verifyStopped(parked.process.id);
    if (parked.expiry) clearTimeout(parked.expiry);
    CodexNativeRuntime.parked.delete(bindingKey);
    for (const [runKey, parkedKey] of CodexNativeRuntime.parkedBindingByRun) {
      if (parkedKey === bindingKey) CodexNativeRuntime.parkedBindingByRun.delete(runKey);
    }
    await parked.toolServer?.close();
  }

  async abort(runId: string): Promise<void> {
    const runKey = `${this.placementKey()}:${runId}`;
    const parkedKey = CodexNativeRuntime.parkedBindingByRun.get(runKey);
    const parkedEntry = parkedKey
      ? ([parkedKey, CodexNativeRuntime.parked.get(parkedKey)] as const)
      : undefined;
    const parked = parkedEntry?.[1];
    const process = CodexNativeRuntime.active.get(runKey) ?? parked?.process;
    if (!process) return;
    const status = await process.stop();
    if (status !== "stopped")
      throw new HarnessUnavailableError("codex-native stop was not confirmed");
    CodexNativeRuntime.stopped.set(runKey, process);
    if (parked) {
      if (parked.expiry) clearTimeout(parked.expiry);
      CodexNativeRuntime.parked.delete(parkedEntry![0]);
      CodexNativeRuntime.parkedBindingByRun.delete(runKey);
      await parked.toolServer?.close();
    }
  }

  async purgeNativeHome(runId: string): Promise<void> {
    const runKey = `${this.placementKey()}:${runId}`;
    const process = CodexNativeRuntime.active.get(runKey) ?? CodexNativeRuntime.stopped.get(runKey);
    if (!process) return;
    await process.purgeHome?.();
    CodexNativeRuntime.stopped.delete(runKey);
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    if (request.execution?.choice.harness !== "codex-native") {
      throw unavailable("codex-native was not selected");
    }
    if (this.placement.cwd.startsWith("/")) {
      throw unavailable("codex-native requires an internal Computer workspace cwd");
    }
    if (!context?.signal || !context.spaceId || !context.userId) {
      throw unavailable("codex-native requires an authorized adapter context");
    }
    if (request.model.provider !== "openai-codex" || !request.model.oauth) {
      throw unavailable("codex-native requires the connected ChatGPT subscription");
    }
    if (!request.model.oauth.credential.accountId) {
      throw unavailable("codex-native requires a ChatGPT account identity");
    }
    const start = this.placement.sandbox.startNativeProcess;
    if (!start || this.placement.computer.kind !== "docker") {
      throw unavailable("selected Computer provider cannot host codex-native");
    }
    const continuity = request.execution.continuity;
    const requestedBindingKey =
      continuity.mode === "resume"
        ? `${this.placementKey()}:${continuity.ref.bindingId}:${continuity.ref.generation}`
        : undefined;
    const requestedParked = requestedBindingKey
      ? CodexNativeRuntime.parked.get(requestedBindingKey)
      : undefined;
    const parkedOnAnotherPlacement =
      continuity.mode === "resume" &&
      [...CodexNativeRuntime.parked.keys()].some((key) =>
        key.endsWith(`:${continuity.ref.bindingId}:${continuity.ref.generation}`),
      );
    if (continuity.mode === "resume" && !requestedParked && parkedOnAnotherPlacement) {
      throw unavailable("codex-native parked session belongs to another Computer placement");
    }
    // The durable host can outlive this worker. A missing local process must
    // become an explicit reconstruction, never an unhandled resume failure.
    const effectiveContinuity =
      continuity.mode === "resume" && !requestedParked
        ? {
            mode: "reconstruct" as const,
            previous: continuity.ref,
            reason: "parked_process_missing",
            inputId: continuity.inputId,
            nativeRef: continuity.nativeRef,
          }
        : continuity;
    // Claim the parked entry before reusing its process. Its previous TTL is
    // only valid while quiescent; leaving it armed could kill an active turn.
    const claimedParked = effectiveContinuity.mode === "resume" ? requestedParked : undefined;
    if (claimedParked) {
      if (claimedParked.expiry) clearTimeout(claimedParked.expiry);
      CodexNativeRuntime.parked.delete(requestedBindingKey!);
    }
    const binding =
      effectiveContinuity.mode === "resume"
        ? effectiveContinuity.ref
        : effectiveContinuity.mode === "reconstruct"
          ? {
              bindingId: effectiveContinuity.previous.bindingId,
              generation: effectiveContinuity.previous.generation + 1,
            }
          : (effectiveContinuity.ref ?? { bindingId: request.runId, generation: 0 });
    const bindingKey = `${this.placementKey()}:${binding.bindingId}:${binding.generation}`;
    const nativeHome = nativeHomeForBinding(this.placement.computer.botId, binding.bindingId);
    const parked = effectiveContinuity.mode === "resume" ? claimedParked : undefined;
    const toolServer =
      parked?.toolServer ??
      (this.options.toolServer ? await this.options.toolServer(request) : undefined);
    let process: NativeProcess | undefined = parked?.process;
    let lines: AsyncIterator<string> | undefined = parked?.lines;
    let threadId: string | undefined = parked?.threadId;
    let parkedAtBoundary = false;
    let turnAccepted = false;
    let completedTurn = false;
    let toolServerArmed = false;
    let primaryError: unknown;
    let cleanupError: unknown;
    let mcpStatus = parked ? "ready" : "missing";
    const observeMcpStatus = (message: Rpc) => {
      if (
        !toolServer ||
        message.method !== "mcpServer/startupStatus/updated" ||
        message.params?.name !== "rakazo"
      )
        return;
      if (
        threadId &&
        typeof message.params.threadId === "string" &&
        message.params.threadId !== threadId
      )
        return;
      const reported = message.params.status;
      mcpStatus =
        typeof reported === "string" &&
        ["starting", "ready", "failed", "cancelled"].includes(reported)
          ? reported
          : "unknown";
      if (mcpStatus !== "ready" && mcpStatus !== "starting")
        throw new NativeMcpUnavailableError(`codex MCP server rakazo is ${mcpStatus}`);
    };
    const requireMcpReady = () => {
      if (toolServer && mcpStatus !== "ready")
        throw new NativeMcpUnavailableError(`codex MCP server rakazo is ${mcpStatus}`);
    };
    try {
      if (toolServer?.arm) {
        // An arm failure may have partially granted authority; always revoke it.
        toolServerArmed = true;
        await toolServer.arm(request);
      }
      if (!process) {
        process = await start.call(
          this.placement.sandbox,
          this.placement.computer,
          {
            argv: ["codex", "app-server", "--listen", "stdio://"],
            cwd: this.placement.cwd,
            privateHome: nativeHome,
            env: {
              CI: "1",
              OPENAI_API_KEY: "",
              CODEX_HOME: nativeHome,
            },
            ...(toolServer
              ? { files: [{ path: "config.toml" as const, content: mcpConfig(toolServer) }] }
              : {}),
          },
          context as AdapterContext,
        );
        lines = process.stdout[Symbol.asyncIterator]();
      }
      const nativeProcess = process;
      const stdout = lines!;
      CodexNativeRuntime.active.set(`${this.placementKey()}:${request.runId}`, nativeProcess);
      const send = async (
        id: number | undefined,
        method: string,
        params: Record<string, unknown>,
      ) =>
        nativeProcess.write(
          `${JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params })}\n`,
        );
      const rejectUnsupportedServerRequest = async (message: Rpc) => {
        const method = message.method ?? "unknown";
        await nativeProcess.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `unsupported codex server request: ${method}` },
          })}\n`,
        );
        throw Object.assign(new Error(`unsupported codex server request: ${method}`), {
          code: "unsupported_codex_server_request",
        });
      };
      const refresh = async (id: string | number) => {
        const refreshOAuth = request.model.oauth!.refresh;
        if (!refreshOAuth) throw new Error("openai-codex OAuth refresh is unavailable");
        const nextCredential = await refreshOAuth(
          request.model.oauth!.credential,
          context.signal ?? new AbortController().signal,
        );
        if (nextCredential.accountId !== request.model.oauth!.credential.accountId) {
          throw new Error("codex OAuth refresh changed the ChatGPT account identity");
        }
        await nativeProcess.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, result: { accessToken: nextCredential.access, chatgptAccountId: nextCredential.accountId } })}\n`,
        );
      };
      const next = async (expectedId: string | number, method: string): Promise<Rpc> => {
        for (;;) {
          const item = await stdout.next();
          if (item.done) {
            const outcome = await nativeProcess.wait();
            throw new Error(
              `codex app-server ended before response (exit code ${outcome.code ?? "unknown"})`,
            );
          }
          const message = JSON.parse(item.value) as Rpc;
          observeMcpStatus(message);
          if (message.error)
            throw new NativeRpcError(
              method,
              message.error.code,
              message.error.message ?? "codex native RPC failed",
            );
          if (
            message.method === "account/chatgptAuthTokens/refresh" &&
            (typeof message.id === "number" || typeof message.id === "string")
          ) {
            await refresh(message.id);
            continue;
          }
          if (message.method && message.id !== undefined)
            await rejectUnsupportedServerRequest(message);
          if (message.id === undefined) continue;
          if (message.id !== expectedId)
            throw new Error(
              `codex response id mismatch: expected ${expectedId}, got ${message.id}`,
            );
          return message;
        }
      };
      let turnRequestId: number;
      // Only a thread started here lacks the conversation; a resumed one already holds it.
      let turnPrompt = request.prompt;
      if (!threadId) {
        await send(1, "initialize", {
          clientInfo: { name: "rakazo", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        await next(1, "initialize");
        await send(undefined, "initialized", {});
        await send(2, "account/login/start", {
          type: "chatgptAuthTokens",
          accessToken: request.model.oauth.credential.access,
          chatgptAccountId: request.model.oauth.credential.accountId,
        });
        await next(2, "account/login/start");
        const resumeThreadId =
          effectiveContinuity.mode === "reconstruct" ? effectiveContinuity.nativeRef : undefined;
        const threadMethod = resumeThreadId ? "thread/resume" : "thread/start";
        // Bot instructions extend, never replace, Codex's base instructions. A
        // reconstructed thread receives them again so the current ones apply.
        await send(3, threadMethod, {
          ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
          ...(request.instructions ? { developerInstructions: request.instructions } : {}),
        });
        let thread: Rpc;
        try {
          thread = await next(3, threadMethod);
        } catch (error) {
          if (
            effectiveContinuity.mode === "reconstruct" &&
            error instanceof NativeRpcError &&
            error.method === "thread/resume" &&
            error.rpcCode === -32600 &&
            /^no rollout found\b/i.test(error.message)
          ) {
            yield {
              type: "native",
              event: {
                type: "error",
                ref: effectiveContinuity.previous,
                reason: "resume_rollout_missing",
              },
            };
            throw unavailable("codex_native_rollout_missing");
          }
          throw error;
        }
        threadId =
          typeof (thread.result?.thread as { id?: unknown } | undefined)?.id === "string"
            ? (thread.result!.thread as { id: string }).id
            : undefined;
        if (!threadId) throw new Error("codex thread/start response missing native thread id");
        if (!resumeThreadId) turnPrompt = promptWithThreadHistory(request);
        turnRequestId = 4;
      } else {
        turnRequestId = 5;
      }
      await send(turnRequestId, "turn/start", {
        threadId,
        input: [{ type: "text", text: turnPrompt }],
        model: request.model.id,
        ...(request.model.thinkingLevel && request.model.thinkingLevel !== "off"
          ? { effort: request.model.thinkingLevel }
          : {}),
      });
      await next(turnRequestId, "turn/start");
      turnAccepted = true;
      yield {
        type: "native",
        event: {
          type: "session",
          ref: binding,
          ...(nativeProcess.id ? { processRef: nativeProcess.id } : {}),
          continuity:
            effectiveContinuity.mode === "resume"
              ? "resumed"
              : effectiveContinuity.mode === "reconstruct"
                ? "reconstructed"
                : "new",
        },
      };
      if (!parked && threadId) {
        yield { type: "native", event: { type: "reference", ref: binding, nativeRef: threadId } };
      }
      let completed = false;
      for (;;) {
        const item = await stdout.next();
        if (item.done) break;
        const message = JSON.parse(item.value) as Rpc;
        observeMcpStatus(message);
        if (message.error?.message) throw new Error(message.error.message);
        if (
          message.method === "account/chatgptAuthTokens/refresh" &&
          (typeof message.id === "number" || typeof message.id === "string")
        ) {
          await refresh(message.id);
          continue;
        }
        if (message.method && message.id !== undefined)
          await rejectUnsupportedServerRequest(message);
        if (
          message.method === "item/agentMessage/delta" &&
          typeof message.params?.delta === "string"
        ) {
          requireMcpReady();
          yield { type: "text", text: message.params.delta };
        }
        if (message.method === "turn/completed") {
          completedTurn = true;
          requireMcpReady();
          const status =
            typeof (message.params?.turn as { status?: unknown } | undefined)?.status === "string"
              ? (message.params!.turn as { status: string }).status
              : undefined;
          if (status !== "completed")
            throw new Error(`codex turn completed with non-success status: ${status ?? "missing"}`);
          yield { type: "done" };
          completed = true;
          break;
        }
      }
      if (!completed) {
        const outcome = await nativeProcess.wait();
        throw new Error(
          `codex app-server ended before turn completion (exit code ${outcome.code ?? "unknown"})`,
        );
      }
      if (toolServerArmed) {
        await toolServer?.disarm?.();
        toolServerArmed = false;
      }
      CodexNativeRuntime.parked.set(bindingKey, {
        process: nativeProcess,
        lines: stdout,
        threadId,
        toolServer,
      });
      CodexNativeRuntime.parkedBindingByRun.set(
        `${this.placementKey()}:${request.runId}`,
        bindingKey,
      );
      const entry = CodexNativeRuntime.parked.get(bindingKey)!;
      entry.expiry = setTimeout(async () => {
        const status = await nativeProcess.stop().catch(() => "stop_unconfirmed" as const);
        if (CodexNativeRuntime.parked.get(bindingKey) !== entry) return;
        CodexNativeRuntime.parked.delete(bindingKey);
        CodexNativeRuntime.parkedBindingByRun.delete(`${this.placementKey()}:${request.runId}`);
        await entry.toolServer?.close().catch(() => undefined);
        try {
          await this.options.onParkExpired?.({ ref: binding, processState: status });
          if (status === "stopped") await nativeProcess.purgeHome?.();
        } catch {
          // A stale durable generation must not become an unhandled timer rejection.
          getLogger().error("codex-native park expiry persistence failed");
        }
      }, parkTtlMs(this.options.parkTtlMs));
      entry.expiry.unref?.();
      parkedAtBoundary = true;
    } catch (error) {
      primaryError = error;
      if (turnAccepted && !completedTurn) {
        yield {
          type: "native",
          event: { type: "error", ref: binding, reason: "turn_outcome_uncertain" },
        };
        if (
          error instanceof NativeMcpUnavailableError ||
          (error instanceof Error &&
            (error as Error & { code?: string }).code === "unsupported_codex_server_request")
        )
          throw error;
        throw new Error("codex turn outcome is uncertain after turn/start", { cause: error });
      }
      throw error;
    } finally {
      const runKey = `${this.placementKey()}:${request.runId}`;
      CodexNativeRuntime.active.delete(runKey);
      if (!parkedAtBoundary) {
        CodexNativeRuntime.parked.delete(bindingKey);
        const status = process
          ? await process.stop().catch(() => "stop_unconfirmed" as const)
          : "stopped";
        if (process && status === "stopped") CodexNativeRuntime.stopped.set(runKey, process);
        if (toolServerArmed) await toolServer?.disarm?.().catch(() => undefined);
        const closeError = toolServer
          ? await toolServer.close().then(
              () => undefined,
              (error) => error,
            )
          : undefined;
        if (status !== "stopped" && primaryError === undefined) {
          cleanupError = new HarnessUnavailableError("codex-native cleanup was not confirmed");
        }
        if (closeError && primaryError === undefined) cleanupError = closeError;
        yield {
          type: "native",
          event: { type: "closed", ref: binding, processState: status },
        };
      }
    }
    if (cleanupError) throw cleanupError;
  }
}

/** @deprecated Compatibility name; there is only one Codex runtime implementation. */
export { CodexNativeRuntime as ComputerCodexNativeRuntime };

/**
 * Not re-exported from the adapters package: only tests use this
 * NODE_ENV=test seam to simulate a worker that lost its local parked registry.
 */
export async function stopAndClearParkedCodexRuntimeForTest(input: {
  computer: ComputerRef;
  ref: { bindingId: string; generation: number };
  verifyStopped: (processRef: string) => Promise<void>;
}): Promise<void> {
  await CodexNativeRuntime.stopAndClearParkedSessionForTest(input);
}
