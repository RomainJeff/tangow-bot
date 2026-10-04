import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ComputerRef,
  NativeProcess,
  NativeProcessRequest,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { ANTHROPIC_OAUTH_PROVIDER } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { NativeAction } from "./computer-native-runtime.js";
import {
  HarnessUnavailableError,
  NATIVE_TOOL_NAME,
  nativeActionCleared,
  nativeActionEvents,
} from "./computer-native-runtime.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import { promptWithThreadHistory } from "./native-history.js";
import type { NativeToolServer } from "./rakazo-mcp-server.js";

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: string;
  mcp_servers?: Array<{ name?: string; status?: string }>;
  is_error?: boolean;
  terminal_reason?: string;
  error?: string;
  result?: string;
  permission_denials?: Array<{ tool_name?: string }>;
  message?: {
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
    error?: string;
  };
};

/** Claude Code's own `tool_use` block, named as the Rakazo tool it matches. */
function claudeAction(block: { name?: string; input?: unknown }): NativeAction | undefined {
  if (typeof block.name !== "string" || !NATIVE_TOOL_NAME.test(block.name)) return;
  const input =
    block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
  if (block.name === "Bash") return { name: "shell", input: { command: input.command } };
  if (block.name === "Read") return { name: "read_file", input: { path: input.file_path } };
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(block.name))
    return { name: "write_file", input: { path: input.file_path ?? input.notebook_path } };
  if (block.name === "WebSearch") return { name: "web_search", input: { query: input.query } };
  if (block.name === "WebFetch") return { name: "web_fetch", input: { url: input.url } };
  // A Rakazo tool reads as it does under Rakazo's own harness.
  const rakazo = block.name.match(/^mcp__rakazo__(.+)$/);
  if (rakazo) return { name: rakazo[1]!, input };
  return { name: block.name, input: {} };
}

// The CLI gets a fixed token and cannot refresh it mid-turn, so a turn needs far more than
// the 5-minute Pi margin; an hour covers long agentic turns and still reuses most of a token's life.
const NATIVE_TURN_MIN_OAUTH_VALIDITY_MS = 60 * 60 * 1000;

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { code: "harness_unavailable" });
}

function nativeConfigDirForBinding(botId: string, bindingId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(botId))
    throw unavailable("claude-native requires a safe Computer bot identity");
  const bindingHash = createHash("sha256").update(bindingId).digest("hex");
  return `/tmp/rakazo-claude-${botId}-${bindingHash}`;
}

export type ClaudeNativeToolServerProvider = (
  attempt: AgentRunRequest,
) => Promise<NativeToolServer>;

function claudeMcpConfig(server: NativeToolServer): string {
  if (!("url" in server.endpoint)) throw unavailable("claude-native requires an HTTP MCP relay");
  return JSON.stringify({
    mcpServers: {
      rakazo: {
        type: "http",
        url: server.endpoint.url,
        headers: server.endpoint.httpHeaders,
      },
    },
  });
}

/** Claude CLI batch runtime (`--print` + `stream-json`, no PTY) whose process can only live in its selected Computer. */
export class ClaudeNativeRuntime implements AgentRuntime {
  private readonly active = new Map<string, NativeProcess>();
  private readonly stopped = new Map<string, NativeProcess>();

  constructor(
    private readonly placement: {
      sandbox: SandboxProvider;
      computer: ComputerRef;
      cwd: string;
    },
    private readonly options: {
      toolServer?: ClaudeNativeToolServerProvider;
    } = {},
  ) {}

  describe() {
    return {
      id: "claude-native",
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

  async abort(runId: string): Promise<void> {
    const process = this.active.get(runId);
    if (!process) return;
    const status = await process.stop();
    if (status !== "stopped")
      throw new HarnessUnavailableError("claude-native stop was not confirmed");
    this.stopped.set(runId, process);
  }

  async purgeNativeHome(runId: string): Promise<void> {
    const process = this.active.get(runId) ?? this.stopped.get(runId);
    if (!process) return;
    await process.purgeHome?.();
    this.stopped.delete(runId);
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    if (request.execution?.choice.harness !== "claude-native") {
      throw unavailable("claude-native was not selected");
    }
    if (this.placement.cwd.startsWith("/")) {
      throw unavailable("claude-native requires an internal Computer workspace cwd");
    }
    if (!context?.signal || !context.spaceId || !context.userId) {
      throw unavailable("claude-native requires an authorized adapter context");
    }
    if (request.model.provider !== ANTHROPIC_OAUTH_PROVIDER || !request.model.oauth?.refresh) {
      throw unavailable("claude-native requires the connected Claude subscription");
    }
    const start = this.placement.sandbox.startNativeProcess;
    if (!start || this.placement.computer.kind !== "docker") {
      throw unavailable("selected Computer provider cannot host claude-native");
    }

    const continuity = request.execution.continuity;
    const binding =
      continuity.mode === "resume"
        ? continuity.ref
        : continuity.mode === "new"
          ? (continuity.ref ?? { bindingId: request.threadId, generation: 0 })
          : {
              bindingId: continuity.previous.bindingId,
              generation: continuity.previous.generation + 1,
            };
    let expectedSessionId: string | undefined;
    if (continuity.mode === "resume" || continuity.mode === "reconstruct") {
      expectedSessionId = continuity.nativeRef;
      if (!expectedSessionId) {
        throw unavailable("claude-native could not resolve the stored session to resume");
      }
    }

    const nativeHome = nativeConfigDirForBinding(this.placement.computer.botId, binding.bindingId);
    let toolServer: NativeToolServer | undefined;
    let toolServerArmed = false;
    const argv = [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--model",
      request.model.id,
      ...(request.instructions
        ? ["--append-system-prompt-file", `${nativeHome}/system-prompt.md`]
        : []),
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      ...(expectedSessionId ? ["--resume", expectedSessionId] : []),
    ];

    let confirmedSessionId: string | undefined;
    const redactSession = (text: string) =>
      redactSecrets(text, [expectedSessionId ?? "", confirmedSessionId ?? ""]);
    let process: NativeProcess | undefined;
    let primaryError: unknown;
    let cleanupError: unknown;
    try {
      toolServer = this.options.toolServer ? await this.options.toolServer(request) : undefined;
      const mcpConfig = toolServer ? claudeMcpConfig(toolServer) : undefined;
      if (mcpConfig) {
        argv.push("--mcp-config", `${nativeHome}/mcp-config.json`, "--strict-mcp-config");
      }
      // Rakazo MCP calls still pass through the armed run's tool authorization.
      argv.push(
        "--allowedTools",
        [...(toolServer ? ["mcp__rakazo"] : []), "Bash", "Edit", "Write", "NotebookEdit"].join(","),
      );
      const files: NonNullable<NativeProcessRequest["files"]> = [];
      if (mcpConfig) files.push({ path: "mcp-config.json", content: mcpConfig });
      if (request.instructions)
        files.push({ path: "system-prompt.md", content: request.instructions });
      const stored = request.model.oauth.credential;
      // Rotating revokes the previous token for every concurrent run on the subscription.
      const credential =
        stored.expires - Date.now() >= NATIVE_TURN_MIN_OAUTH_VALIDITY_MS
          ? stored
          : await request.model.oauth.refresh(stored, context.signal);
      if (!credential.access) {
        throw unavailable("claude-native OAuth refresh returned no access credential");
      }
      const secrets = () => [
        confirmedSessionId ?? "",
        expectedSessionId ?? "",
        credential.access,
        credential.refresh,
        request.model.oauth!.credential.access,
        request.model.oauth!.credential.refresh,
        toolServer?.ticket ?? "",
        ...(request.secrets ?? []),
      ];
      let actions = 0;
      let actionShowing = false;
      if (toolServer?.arm) {
        // An arm failure may have partially granted authority; always revoke it.
        toolServerArmed = true;
        await toolServer.arm(request);
      }
      const nativeProcess = await start.call(
        this.placement.sandbox,
        this.placement.computer,
        {
          argv,
          cwd: this.placement.cwd,
          privateHome: nativeHome,
          env: {
            CI: "1",
            CLAUDE_CONFIG_DIR: nativeHome,
            CLAUDE_CODE_OAUTH_TOKEN: credential.access,
          },
          ...(files.length ? { files } : {}),
        },
        context as AdapterContext,
      );
      process = nativeProcess;
      this.active.set(request.runId, nativeProcess);
      await nativeProcess.write(
        `${JSON.stringify({
          type: "user",
          // A session resumed by reference already holds the conversation.
          message: {
            role: "user",
            content: expectedSessionId ? request.prompt : promptWithThreadHistory(request),
          },
        })}\n`,
      );

      const lines = nativeProcess.stdout[Symbol.asyncIterator]();
      let completed = false;
      let sessionConfirmed = false;
      let assistantError: string | undefined;
      let assistantErrorText: string | undefined;
      for (;;) {
        const item = await lines.next();
        if (item.done) break;
        const message = JSON.parse(item.value) as ClaudeStreamEvent;

        if (!sessionConfirmed) {
          if (message.type !== "system" || message.subtype !== "init") continue;
          const sessionId = message.session_id;
          if (typeof sessionId !== "string") {
            throw new Error("claude init event is missing session_id");
          }
          confirmedSessionId = sessionId;
          if (toolServer) {
            const reported = message.mcp_servers?.find(
              (server) => server.name === "rakazo",
            )?.status;
            const status =
              reported === undefined
                ? "missing"
                : ["connected", "failed", "needs-auth", "pending", "disabled"].includes(reported)
                  ? reported
                  : "unknown";
            if (status !== "connected") throw new Error(`claude MCP server rakazo is ${status}`);
          }
          if (continuity.mode === "resume" || continuity.mode === "reconstruct") {
            if (sessionId !== expectedSessionId) {
              throw new Error("claude resume session mismatch");
            }
            sessionConfirmed = true;
            yield {
              type: "native",
              event: {
                type: "session",
                ref: binding,
                ...(nativeProcess.id ? { processRef: nativeProcess.id } : {}),
                continuity: continuity.mode === "resume" ? "resumed" : "reconstructed",
              },
            };
          } else {
            sessionConfirmed = true;
            yield {
              type: "native",
              event: {
                type: "session",
                ref: binding,
                ...(nativeProcess.id ? { processRef: nativeProcess.id } : {}),
                continuity: "new",
              },
            };
          }
          yield {
            type: "native",
            event: { type: "reference", ref: binding, nativeRef: sessionId },
          };
          continue;
        }

        if (message.type === "assistant") {
          if (typeof message.error === "string") {
            assistantError = message.error;
          } else if (typeof message.message?.error === "string") {
            assistantError = message.message.error;
          }
          if (message.error || message.message?.error) {
            assistantErrorText = (message.message?.content ?? [])
              .filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text)
              .join(" ")
              .trim();
          }
          for (const block of message.message?.content ?? []) {
            if (block.type === "text" && typeof block.text === "string") {
              if (actionShowing) yield nativeActionCleared;
              actionShowing = false;
              yield { type: "text", text: redactSession(block.text) };
            }
            const action = block.type === "tool_use" ? claudeAction(block) : undefined;
            if (action) {
              yield* nativeActionEvents(action, `${request.runId}:native-${++actions}`, secrets());
              actionShowing = true;
            }
          }
          continue;
        }

        if (message.type === "result") {
          if (Array.isArray(message.permission_denials)) {
            for (const denial of message.permission_denials) {
              // Only a bounded tool name may leave this envelope, never tool_input
              // or tool_use_id. Malformed names must not turn into public arguments.
              const name =
                typeof denial?.tool_name === "string" && NATIVE_TOOL_NAME.test(denial.tool_name)
                  ? denial.tool_name
                  : "un outil";
              const tool = sanitizeConnectorError(name, secrets());
              getLogger().warn("claude-native permission denied", { tool });
              yield { type: "text", text: `Claude a demandé ${tool}, refusé par la politique.\n` };
            }
          }
          const failed =
            message.subtype !== "success" ||
            message.is_error === true ||
            // claude 2.1.282 reports a normal finish as terminal_reason "completed".
            (typeof message.terminal_reason === "string" &&
              message.terminal_reason !== "completed") ||
            assistantError !== undefined;
          if (failed) {
            const reason =
              assistantError ??
              message.error ??
              message.terminal_reason ??
              (message.is_error === true ? "is_error" : undefined) ??
              message.subtype;
            // Only CLI-readable fields belong in the public error, never the API envelope.
            const detail =
              assistantErrorText ||
              (typeof message.result === "string" ? message.result.trim() : "");
            const safeMessage = sanitizeConnectorError(
              `claude turn failed: ${reason}${detail ? `: ${detail}` : ""}`,
              secrets(),
            ).slice(0, 300);
            throw new Error(safeMessage);
          }
          completed = true;
          break;
        }
      }

      if (!completed) {
        const outcome = await nativeProcess.wait();
        throw new Error(
          `claude ended before turn completion (exit code ${outcome.code ?? "unknown"})`,
        );
      }
      if (toolServerArmed) {
        await toolServer?.disarm?.();
        toolServerArmed = false;
      }
    } catch (error) {
      if (error instanceof Error) error.message = redactSession(error.message);
      primaryError = error;
      throw error;
    } finally {
      const status = process
        ? await process.stop().catch(() => "stop_unconfirmed" as const)
        : "stopped";
      if (status === "stopped") {
        this.active.delete(request.runId);
        if (process) this.stopped.set(request.runId, process);
      }
      if (toolServerArmed) await toolServer?.disarm?.().catch(() => undefined);
      const closeError = toolServer
        ? await toolServer.close().then(
            () => undefined,
            (error) => error,
          )
        : undefined;
      if (status !== "stopped" && primaryError === undefined) {
        cleanupError = new HarnessUnavailableError("claude-native cleanup was not confirmed");
      }
      if (closeError && primaryError === undefined) cleanupError = closeError;
    }
    if (cleanupError) throw cleanupError;
    // --print finishes a process per turn; preserve its home for --resume without
    // claiming that a live process remains parked. Publish success after cleanup.
    yield { type: "native", event: { type: "parked", ref: binding, processState: "stopped" } };
    yield { type: "done" };
  }
}
