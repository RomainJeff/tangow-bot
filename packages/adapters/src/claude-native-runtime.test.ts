import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  ComputerRef,
  NativeProcess,
  NativeRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { ClaudeNativeRuntime } from "./claude-native-runtime.js";
import type { NativeToolServer } from "./rakazo-mcp-server.js";

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

const request = (
  runId: string,
  continuity: AgentRunRequest["execution"] extends infer E
    ? E extends { continuity: infer C }
      ? C
      : never
    : never,
  overrides: Partial<Pick<AgentRunRequest, "instructions" | "model">> = {},
): AgentRunRequest => ({
  botId: "bot",
  threadId: "thread",
  runId,
  prompt: "hello",
  instructions: overrides.instructions ?? "",
  history: [],
  tools: [],
  model: overrides.model ?? {
    provider: "anthropic",
    id: "claude-sonnet",
    oauth: {
      credential: {
        type: "oauth",
        access: "initial-access",
        refresh: "refresh-value-is-never-forwarded",
        expires: 0,
      },
      refresh: async (credential) => credential,
    },
  },
  execution: {
    choice: { harness: "claude-native" as const, targetId: "computer" },
    authority: { runId, attemptId: "attempt", fence: 1, policyRevision: 1 },
    continuity,
    computerId: "computer",
  },
});

function fakeProcess(
  lines: string[],
  write: NativeProcess["write"] = vi.fn(async () => undefined),
): NativeProcess {
  return {
    write,
    stdout: (async function* () {
      for (const line of lines) yield `${line}\n`;
    })(),
    stderr: (async function* () {})(),
    wait: async () => ({ code: 0 }),
    stop: async () => "stopped",
  };
}

/** Claude Code 2.1.282 validates the JSONL user message before authentication. */
function acceptsClaude282StreamJsonUserEvent(input: string): boolean {
  const lines = input.trimEnd().split("\n");
  if (lines.length !== 1) return false;
  const parsed: unknown = JSON.parse(lines[0] ?? "");
  if (!parsed || typeof parsed !== "object") return false;
  const event = parsed as {
    type?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  return (
    event.type === "user" &&
    event.message?.role === "user" &&
    typeof event.message.content === "string"
  );
}

describe("ClaudeNativeRuntime", () => {
  it.each([false, true])(
    "reports result permission denials without arguments even on failure=%s",
    async (failed) => {
      const log = vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      const process = fakeProcess([
        JSON.stringify({ type: "system", subtype: "init", session_id: "private-session" }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: failed,
          permission_denials: [
            {
              tool_name: "Bash",
              tool_use_id: "private-call",
              tool_input: { command: "private-argument" },
            },
            { tool_name: "mcp__rakazo__write", tool_input: { token: "private-token" } },
          ],
        }),
      ]);
      const runtime = new ClaudeNativeRuntime({
        sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      });
      const texts: string[] = [];
      try {
        const run = (async () => {
          for await (const event of runtime.run(request("denials", { mode: "new" }), context)) {
            if (event.type === "text") texts.push(event.text);
          }
        })();
        if (failed) await expect(run).rejects.toThrow("claude turn failed");
        else await run;
        expect(texts).toEqual([
          "Claude a demandé Bash, refusé par la politique.\n",
          "Claude a demandé mcp__rakazo__write, refusé par la politique.\n",
        ]);
        expect(log.mock.calls).toEqual([
          ["claude-native permission denied", { tool: "Bash" }],
          ["claude-native permission denied", { tool: "mcp__rakazo__write" }],
        ]);
        const output = JSON.stringify({ texts, logs: log.mock.calls });
        for (const secret of [
          "private-call",
          "private-argument",
          "private-token",
          "private-session",
        ])
          expect(output).not.toContain(secret);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("confirms process exit before completing a resumable parked turn", async () => {
    let stopped = false;
    const process = fakeProcess([
      JSON.stringify({ type: "system", subtype: "init", session_id: "resumable-session" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);
    process.stop = async () => {
      stopped = true;
      return "stopped";
    };
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const events = [];
    for await (const event of runtime.run(request("exit", { mode: "new" }), context)) {
      if (event.type === "done") expect(stopped).toBe(true);
      events.push(event);
    }
    expect(events).toContainEqual({
      type: "native",
      event: {
        type: "parked",
        ref: { bindingId: "thread", generation: 0 },
        processState: "stopped",
      },
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("keeps an unconfirmed process reachable by abort after turn cleanup", async () => {
    const process = fakeProcess([
      JSON.stringify({ type: "system", subtype: "init", session_id: "uncertain" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);
    process.stop = async () => "stop_unconfirmed";
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    await expect(
      (async () => {
        for await (const _event of runtime.run(request("uncertain", { mode: "new" }), context)) {
        }
      })(),
    ).rejects.toThrow("cleanup was not confirmed");
    await expect(runtime.abort("uncertain")).rejects.toThrow("stop was not confirmed");
  });

  it.each(["success", "arm", "start", "write", "return"])(
    "arms before launch and disarms on %s",
    async (outcome) => {
      const order: string[] = [];
      const process: NativeProcess = {
        write: async () => {
          if (outcome === "write") throw new Error("write failed");
        },
        stdout: (async function* () {
          yield JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: "cli-arm-session",
            mcp_servers: [{ name: "rakazo", status: "connected" }],
          });
          yield JSON.stringify({ type: "result", subtype: "success" });
        })(),
        stderr: (async function* () {})(),
        wait: async () => ({ code: 0 }),
        stop: async () => {
          order.push("stop");
          return "stopped";
        },
      };
      const runtime = new ClaudeNativeRuntime(
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
        for await (const _event of runtime.run(
          request(`arm-${outcome}`, { mode: "new" }),
          context,
        )) {
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
    },
  );

  it.each(["connected", "failed", "needs-auth", "pending", "disabled", "missing", "unknown"])(
    "requires a connected rakazo MCP server: %s",
    async (status) => {
      const process = fakeProcess([
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "cli-mcp-session",
          mcp_servers:
            status === "missing"
              ? [{ name: "other", status: "connected" }]
              : [
                  {
                    name: "rakazo",
                    status: status === "unknown" ? "private-provider-detail" : status,
                  },
                ],
        }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } }),
        JSON.stringify({ type: "result", subtype: "success", terminal_reason: "completed" }),
      ]);
      const disarm = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const runtime = new ClaudeNativeRuntime(
        {
          sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
          computer,
          cwd: ".",
        },
        {
          toolServer: async () => ({
            ticket: "test-ticket",
            endpoint: {
              url: "http://rakazo-mcp/native-mcp",
              httpHeaders: { Authorization: "Bearer test-ticket" },
            },
            arm: async () => {},
            disarm,
            close,
          }),
        },
      );
      const events: Array<{ type: string }> = [];
      const run = (async () => {
        for await (const event of runtime.run(request(`mcp-${status}`, { mode: "new" }), context))
          events.push(event);
      })();
      if (status === "connected") await run;
      else await expect(run).rejects.toThrow(`claude MCP server rakazo is ${status}`);
      expect(events.some((event) => event.type === "done")).toBe(status === "connected");
      expect(disarm).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("ignores MCP status when no toolServer was composed", async () => {
    const process = fakeProcess([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cli-no-mcp",
        mcp_servers: [{ name: "rakazo", status: "failed" }],
      }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const events = [];
    for await (const event of runtime.run(request("no-mcp", { mode: "new" }), context))
      events.push(event);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it.each(["assistant", "result"])(
    "surfaces the readable usage-credit error from %s",
    async (source) => {
      const detail = "Fable 5.1 requires usage credits. Switch to another model to continue.";
      const process = fakeProcess([
        JSON.stringify({ type: "system", subtype: "init", session_id: "cli-session-credits" }),
        ...(source === "assistant"
          ? [
              JSON.stringify({
                type: "assistant",
                error: "rate_limit",
                apiError: "model_requires_usage_credits",
                message: { content: [{ type: "text", text: detail }] },
                request_id: "req_private_fixture",
              }),
            ]
          : []),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          error: "rate_limit",
          result: source === "result" ? detail : "",
          request_id: "req_private_fixture",
        }),
      ]);
      const runtime = new ClaudeNativeRuntime({
        sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      });
      await expect(
        (async () => {
          for await (const _event of runtime.run(request("credits", { mode: "new" }), context))
            undefined;
        })(),
      ).rejects.toThrow(`claude turn failed: rate_limit: ${detail}`);
    },
  );

  it.each(["text", "error", "mismatch"])(
    "never exposes session_id in public %s",
    async (channel) => {
      const sessionId = "private-cli-session";
      const process = fakeProcess([
        JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: `session ${sessionId}` }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: channel === "error" ? "error" : "success",
          result: `session ${sessionId}`,
        }),
      ]);
      const runtime = new ClaudeNativeRuntime({
        sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      });
      const publicOutput: string[] = [];
      try {
        for await (const event of runtime.run(
          request(
            "privacy",
            channel === "mismatch"
              ? {
                  mode: "resume",
                  ref: { bindingId: "binding", generation: 0 },
                  inputId: "input-1",
                  nativeRef: "expected-private-session",
                }
              : { mode: "new" },
          ),
          context,
        )) {
          if (event.type === "text") publicOutput.push(event.text);
        }
      } catch (error) {
        publicOutput.push((error as Error).message);
      }
      expect(publicOutput.length).toBeGreaterThan(0);
      expect(publicOutput.join(" ")).not.toContain(sessionId);
      expect(publicOutput.join(" ")).not.toContain("expected-private-session");
    },
  );

  it("redacts credentials before bounding the public error and ignores API metadata", async () => {
    const detail = `Not logged in initial-access Bearer fake-bearer ${"x".repeat(400)}`;
    const process = fakeProcess([
      JSON.stringify({ type: "system", subtype: "init", session_id: "bounded" }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        result: detail,
        apiError: { request_id: "req_private_fixture", detail: "private API body" },
      }),
    ]);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    await expect(
      (async () => {
        for await (const _event of runtime.run(request("bounded", { mode: "new" }), context))
          undefined;
      })(),
    ).rejects.toEqual(
      new Error(
        `claude turn failed: error: Not logged in [redacted] Bearer [redacted] ${"x".repeat(400)}`.slice(
          0,
          300,
        ),
      ),
    );
  });

  it.each([
    { withToolServer: false, allowedTools: "Bash,Edit,Write,NotebookEdit" },
    { withToolServer: true, allowedTools: "mcp__rakazo,Bash,Edit,Write,NotebookEdit" },
  ])(
    "pre-approves a closed tool list with toolServer=$withToolServer",
    async ({ withToolServer, allowedTools }) => {
      const process = fakeProcess([
        '{"type":"system","subtype":"init","session_id":"permissions","mcp_servers":[{"name":"rakazo","status":"connected"}]}',
        '{"type":"result","subtype":"success"}',
      ]);
      const startNativeProcess = vi.fn<NonNullable<SandboxProvider["startNativeProcess"]>>(
        async () => process,
      );
      const runtime = new ClaudeNativeRuntime(
        { sandbox: { startNativeProcess } as unknown as SandboxProvider, computer, cwd: "." },
        withToolServer
          ? {
              toolServer: async () => ({
                ticket: "test-ticket",
                endpoint: {
                  url: "http://rakazo-mcp:7091/native-mcp",
                  httpHeaders: { Authorization: "Bearer test-ticket" },
                },
                close: async () => {},
              }),
            }
          : {},
      );

      for await (const _event of runtime.run(request("permissions", { mode: "new" }), context))
        undefined;

      const argv = startNativeProcess.mock.calls[0]![1].argv;
      expect(argv).toContain("--allowedTools");
      expect(argv.slice(argv.indexOf("--allowedTools"))).toEqual(["--allowedTools", allowedTools]);
      expect(
        argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 4),
      ).toEqual(["--permission-mode", "dontAsk", "--permission-prompts", "none"]);
      expect(argv).not.toContain("--dangerously-skip-permissions");
      expect(argv).not.toContain("--allow-dangerously-skip-permissions");
    },
  );

  it("writes the Claude 2.1.282 stream-json user event accepted before authentication", async () => {
    const sessionId = "00000000-0000-0000-0000-000000000010";
    const write = vi.fn<NativeProcess["write"]>(async () => undefined);
    const process = fakeProcess(
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
        JSON.stringify({ type: "result", subtype: "success" }),
      ],
      write,
    );
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    for await (const _event of runtime.run(request("stream-json-role", { mode: "new" }), context))
      undefined;

    expect(acceptsClaude282StreamJsonUserEvent(write.mock.calls[0]?.[0] ?? "")).toBe(true);
  });

  it("composes the armed MCP relay as Claude 2.1.282 JSON in the private config home", async () => {
    const sessionId = "00000000-0000-0000-0000-000000000001";
    const process = fakeProcess([
      `{"type":"system","subtype":"init","session_id":"${sessionId}","mcp_servers":[{"name":"rakazo","status":"connected"}]}`,
      '{"type":"result","subtype":"success"}',
    ]);
    const toolServer = vi.fn(
      async (): Promise<NativeToolServer> => ({
        ticket: "test-ticket",
        endpoint: {
          url: "http://rakazo-mcp:7091/native-mcp",
          httpHeaders: { Authorization: "Bearer test-ticket" },
        },
        close: vi.fn(async () => undefined),
        arm: vi.fn(async () => undefined),
        disarm: vi.fn(async () => undefined),
      }),
    );
    const startNativeProcess = vi.fn<NonNullable<SandboxProvider["startNativeProcess"]>>(
      async () => process,
    );
    const runtime = new ClaudeNativeRuntime(
      { sandbox: { startNativeProcess } as unknown as SandboxProvider, computer, cwd: "." },
      { toolServer },
    );

    const run = request("mcp-composed", { mode: "new" });
    for await (const _event of runtime.run(run, context)) undefined;

    expect(toolServer).toHaveBeenCalledWith(run);
    const nativeRequest = startNativeProcess.mock.calls[0]![1] as {
      argv: string[];
      files?: Array<{ path: string; content: string }>;
    };
    expect(nativeRequest.argv).toContain("--mcp-config");
    expect(nativeRequest.argv).toContain(
      "/tmp/rakazo-claude-bot-39200d1e8a8dbbb6d7bcea51e02b99f062d32a5f83151e8c5a9fab79576245dd/mcp-config.json",
    );
    expect(nativeRequest.argv).toContain("--strict-mcp-config");
    expect(nativeRequest.files).toEqual([
      {
        path: "mcp-config.json",
        content: JSON.stringify({
          mcpServers: {
            rakazo: {
              type: "http",
              url: "http://rakazo-mcp:7091/native-mcp",
              headers: { Authorization: "Bearer test-ticket" },
            },
          },
        }),
      },
    ]);
    const server = await toolServer.mock.results[0]!.value;
    expect(server.arm).toHaveBeenCalledWith(run);
    expect(server.disarm).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("rejects a non-Anthropic model before starting a Claude native process", async () => {
    const startNativeProcess = vi.fn();
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    await expect(
      (async () => {
        for await (const _event of runtime.run(
          request(
            "wrong-provider",
            { mode: "new" },
            {
              model: { provider: "openai-codex", id: "gpt-5.6" },
            },
          ),
          context,
        ))
          undefined;
      })(),
    ).rejects.toThrow("claude-native requires the connected Claude subscription");
    expect(startNativeProcess).not.toHaveBeenCalled();
  });

  it("passes the effective Anthropic model, run instructions, non-interactive permissions and renewed OAuth access through a private thread-bound config directory", async () => {
    const sessionId = "00000000-0000-0000-0000-000000000000";
    const process = fakeProcess([
      `{"type":"system","subtype":"init","session_id":"${sessionId}","mcp_servers":[{"name":"rakazo","status":"connected"}]}`,
      '{"type":"result","subtype":"success"}',
    ]);
    const startNativeProcess = vi.fn<
      (computer: ComputerRef, request: unknown, context: AdapterContext) => Promise<NativeProcess>
    >(async () => process);
    const refresh = vi.fn(async () => ({
      type: "oauth" as const,
      access: "renewed-access",
      refresh: "refresh-value-is-never-forwarded",
      expires: 1,
    }));
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events = [];
    for await (const event of runtime.run(
      request(
        "new-thread-run",
        { mode: "new" },
        {
          instructions: "Follow the run-specific rule.",
          model: {
            provider: "anthropic",
            id: "claude-sonnet-5",
            oauth: {
              credential: {
                type: "oauth",
                access: "initial-access",
                refresh: "refresh-value-is-never-forwarded",
                expires: 0,
              },
              refresh,
            },
          },
        },
      ),
      context,
    ))
      events.push(event);

    expect(refresh).toHaveBeenCalledOnce();
    expect(startNativeProcess).toHaveBeenCalledWith(
      computer,
      {
        argv: [
          "claude",
          "--print",
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--verbose",
          "--model",
          "claude-sonnet-5",
          "--append-system-prompt-file",
          "/tmp/rakazo-claude-bot-39200d1e8a8dbbb6d7bcea51e02b99f062d32a5f83151e8c5a9fab79576245dd/system-prompt.md",
          "--permission-mode",
          "dontAsk",
          "--permission-prompts",
          "none",
          "--allowedTools",
          "Bash,Edit,Write,NotebookEdit",
        ],
        cwd: ".",
        files: [{ path: "system-prompt.md", content: "Follow the run-specific rule." }],
        privateHome:
          "/tmp/rakazo-claude-bot-39200d1e8a8dbbb6d7bcea51e02b99f062d32a5f83151e8c5a9fab79576245dd",
        env: {
          CI: "1",
          CLAUDE_CONFIG_DIR:
            "/tmp/rakazo-claude-bot-39200d1e8a8dbbb6d7bcea51e02b99f062d32a5f83151e8c5a9fab79576245dd",
          CLAUDE_CODE_OAUTH_TOKEN: "renewed-access",
        },
      },
      context,
    );
    expect(events[0]).toEqual({
      type: "native",
      event: {
        type: "session",
        ref: { bindingId: "thread", generation: 0 },
        continuity: "new",
      },
    });
  });

  it("resumes a session from the durable native reference and confirms it from the CLI's own init event", async () => {
    const ref: NativeRef = { bindingId: "rakazo-binding-42", generation: 3 };
    const externalSessionId = "11111111-1111-1111-1111-111111111111";
    const process = fakeProcess([
      `{"type":"system","subtype":"init","session_id":"${externalSessionId}"}`,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success"}',
    ]);
    const startNativeProcess = vi.fn<
      (computer: ComputerRef, request: unknown, context: AdapterContext) => Promise<NativeProcess>
    >(async () => process);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events = [];
    for await (const event of runtime.run(
      request("resume", { mode: "resume", ref, inputId: "input-1", nativeRef: externalSessionId }),
      context,
    ))
      events.push(event);

    const nativeRequest = startNativeProcess.mock.calls[0]![1] as {
      argv: string[];
      env?: Record<string, string>;
    };
    expect(nativeRequest.argv).toContain("--resume");
    expect(nativeRequest.argv).toContain(externalSessionId);
    expect(nativeRequest.argv.join(" ")).not.toContain(ref.bindingId);
    expect(JSON.stringify(nativeRequest.env ?? {})).not.toContain(externalSessionId);
    expect(events[0]).toEqual({
      type: "native",
      event: { type: "session", ref, continuity: "resumed" },
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("rejects a resume when the CLI's init event reports a different session than the one requested", async () => {
    const ref: NativeRef = { bindingId: "rakazo-binding-9", generation: 1 };
    const externalSessionId = "22222222-2222-2222-2222-222222222222";
    const otherSessionId = "33333333-3333-3333-3333-333333333333";
    const process = fakeProcess([
      `{"type":"system","subtype":"init","session_id":"${otherSessionId}"}`,
      '{"type":"result","subtype":"success"}',
    ]);
    const runtime = new ClaudeNativeRuntime({
      sandbox: {
        startNativeProcess: async () => process,
      } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    await expect(
      (async () => {
        for await (const _event of runtime.run(
          request("resume-mismatch", {
            mode: "resume",
            ref,
            inputId: "input-1",
            nativeRef: externalSessionId,
          }),
          context,
        ))
          undefined;
      })(),
    ).rejects.toThrow(/session mismatch/);
  });

  it("reconstructs with the stored session in the binding's existing config directory", async () => {
    const previous: NativeRef = { bindingId: "rakazo-binding-10", generation: 4 };
    const externalSessionId = "55555555-5555-5555-5555-555555555555";
    const process = fakeProcess([
      `{"type":"system","subtype":"init","session_id":"${externalSessionId}"}`,
      '{"type":"result","subtype":"success"}',
    ]);
    const startNativeProcess = vi.fn<
      (computer: ComputerRef, request: unknown, context: AdapterContext) => Promise<NativeProcess>
    >(async () => process);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events = [];
    for await (const event of runtime.run(
      request("reconstruct", {
        mode: "reconstruct",
        previous,
        reason: "parked_process_missing",
        inputId: "input-1",
        nativeRef: externalSessionId,
      }),
      context,
    ))
      events.push(event);

    const nativeRequest = startNativeProcess.mock.calls[0]![1] as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(nativeRequest.argv).toEqual(expect.arrayContaining(["--resume", externalSessionId]));
    expect(nativeRequest.env.CLAUDE_CONFIG_DIR).toBe(
      `/tmp/rakazo-claude-${computer.botId}-${createHash("sha256")
        .update(previous.bindingId)
        .digest("hex")}`,
    );
    expect(events[0]).toEqual({
      type: "native",
      event: {
        type: "session",
        ref: { bindingId: previous.bindingId, generation: previous.generation + 1 },
        continuity: "reconstructed",
      },
    });
  });

  it("starts a new session without --resume and emits continuity new only after the CLI confirms init", async () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const process = fakeProcess([
      `{"type":"system","subtype":"init","session_id":"${sessionId}","mcp_servers":[{"name":"rakazo","status":"connected"}]}`,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success"}',
    ]);
    const startNativeProcess = vi.fn<
      (computer: ComputerRef, request: unknown, context: AdapterContext) => Promise<NativeProcess>
    >(async () => process);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events = [];
    for await (const event of runtime.run(request("new", { mode: "new" }), context))
      events.push(event);

    const nativeRequest = startNativeProcess.mock.calls[0]![1] as { argv: string[] };
    expect(nativeRequest.argv).not.toContain("--resume");
    expect(events[0]).toEqual({
      type: "native",
      event: {
        type: "session",
        ref: { bindingId: "thread", generation: 0 },
        continuity: "new",
      },
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("feeds the Rakazo thread history to a new native session and never to a resumed one", async () => {
    const history: AgentRunRequest["history"] = [
      { role: "user", content: "the launch code word is mimosa" },
      { role: "assistant", content: "Noted, the code word is mimosa." },
    ];
    const sessionId = "77777777-7777-7777-7777-777777777777";
    const sentPrompt = async (continuity: Parameters<typeof request>[1]) => {
      const write = vi.fn<NativeProcess["write"]>(async () => undefined);
      const process = fakeProcess(
        [
          `{"type":"system","subtype":"init","session_id":"${sessionId}"}`,
          '{"type":"result","subtype":"success"}',
        ],
        write,
      );
      const runtime = new ClaudeNativeRuntime({
        sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      });
      for await (const _event of runtime.run(
        { ...request("history", continuity), history },
        context,
      ))
        undefined;
      return (JSON.parse(write.mock.calls[0]![0]) as { message: { content: string } }).message
        .content;
    };

    const fresh = await sentPrompt({ mode: "new" });
    expect(fresh).toContain("the launch code word is mimosa");
    expect(fresh).toContain("Noted, the code word is mimosa.");
    expect(fresh).toContain("hello");
    expect(
      await sentPrompt({
        mode: "resume",
        ref: { bindingId: "thread", generation: 0 },
        inputId: "input-1",
        nativeRef: sessionId,
      }),
    ).toBe("hello");
  });

  it("publishes session_id only as a native reference, never in text events or public errors", async () => {
    const sessionId = "66666666-6666-6666-6666-666666666666";
    const process = fakeProcess([
      `{"type":"system","subtype":"init","session_id":"${sessionId}","mcp_servers":[{"name":"rakazo","status":"connected"}]}`,
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success"}',
    ]);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events = [];
    for await (const event of runtime.run(request("opaque-binding", { mode: "new" }), context))
      events.push(event);

    const sessionEvent = events[0] as {
      type: "native";
      event: { type: "session"; ref: NativeRef; continuity: string };
    };
    expect(sessionEvent.event.ref.bindingId).toBe("thread");
    expect(events).toContainEqual({
      type: "native",
      event: { type: "reference", ref: sessionEvent.event.ref, nativeRef: sessionId },
    });
    expect(JSON.stringify(events.filter((event) => event.type === "text"))).not.toContain(
      sessionId,
    );
  });

  it("rejects a synthetic CLI-observed unauthenticated turn instead of emitting done (result.subtype success with is_error/terminal_reason api_error)", async () => {
    // Fixture: synthetic — reproduces the sequence observed on real
    // `claude` 2.1.278 without auth:
    // system/init with apiKeySource "none", an assistant turn saying "Not logged in" with
    // `error:"authentication_failed"` at the top level of the assistant event (not
    // `message.error`, which does not match the real capture), then a result with
    // subtype:"success" but is_error:true and terminal_reason:"api_error".
    const sessionId = "77777777-7777-7777-7777-777777777777";
    const process = fakeProcess([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        apiKeySource: "none",
      }),
      JSON.stringify({
        type: "assistant",
        error: "authentication_failed",
        message: {
          content: [{ type: "text", text: "Not logged in · Please run /login" }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        session_id: sessionId,
      }),
    ]);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of runtime.run(
          request("synthetic-auth-fail", { mode: "new" }),
          context,
        ))
          events.push(event);
      })(),
    ).rejects.toThrow(
      "claude turn failed: authentication_failed: Not logged in · Please run /login",
    );

    expect(events.some((e) => (e as { type?: string }).type === "done")).toBe(false);
    expect(events.some((e) => (e as { type?: string }).type === "text")).toBe(true);
  });

  it.each([
    { terminalReason: "completed", fails: false },
    { terminalReason: "max_turns", fails: true },
  ])(
    "classifies the real claude 2.1.282 result terminal_reason $terminalReason",
    async ({ terminalReason, fails }) => {
      // Fixture: shape of the real CLI 2.1.282 success result seen live on 2026-09-26
      // (`terminal_reason:"completed"`); `end_turn` is not a terminal_reason value.
      const sessionId = "66666666-6666-6666-6666-666666666666";
      const process = fakeProcess([
        JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          terminal_reason: terminalReason,
          result: "OK",
          session_id: sessionId,
        }),
      ]);
      const runtime = new ClaudeNativeRuntime({
        sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
        computer,
        cwd: ".",
      });
      const events: Array<{ type?: string }> = [];
      const run = (async () => {
        for await (const event of runtime.run(
          request(`terminal-${terminalReason}`, { mode: "new" }),
          context,
        ))
          events.push(event as { type?: string });
      })();
      if (fails) await expect(run).rejects.toThrow(`claude turn failed: ${terminalReason}`);
      else await run;
      expect(events.some((event) => event.type === "done")).toBe(!fails);
    },
  );

  it("rejects on is_error alone, isolated from terminal_reason (mutant guard: ignoring is_error must fail this test)", async () => {
    // Fixture: synthetic — result carries is_error:true with no terminal_reason at all,
    // so a mutant that drops the `message.is_error === true` check cannot hide behind
    // the terminal_reason branch.
    const sessionId = "88888888-8888-8888-8888-888888888888";
    const process = fakeProcess([
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        session_id: sessionId,
      }),
    ]);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of runtime.run(request("is-error-only", { mode: "new" }), context))
          events.push(event);
      })(),
    ).rejects.toThrow(/claude turn failed: is_error/);

    expect(events.some((e) => (e as { type?: string }).type === "done")).toBe(false);
    expect(events.some((e) => (e as { type?: string }).type === "text")).toBe(false);
  });

  it("rejects when assistant.error is set even though the final result reports subtype success with no is_error", async () => {
    // Fixture: synthetic — a top-level `error` on the assistant
    // event must drive the failure decision and the reason, even when `result` alone
    // would look like a clean success.
    const sessionId = "99999999-9999-9999-9999-999999999999";
    const process = fakeProcess([
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
      JSON.stringify({
        type: "assistant",
        error: "authentication_failed",
        message: { content: [{ type: "text", text: "Not logged in" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", session_id: sessionId }),
    ]);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of runtime.run(
          request("assistant-error-only", { mode: "new" }),
          context,
        ))
          events.push(event);
      })(),
    ).rejects.toThrow(/claude turn failed: authentication_failed/);

    expect(events.some((e) => (e as { type?: string }).type === "done")).toBe(false);
  });

  it("streams assistant text as it arrives, then rejects on a failing result without emitting done", async () => {
    // Fixture: synthetic — proves streaming capability stays real: the text block is
    // yielded before the failing result is even read, mirroring CodexNativeRuntime's
    // deltas-then-rejection behavior for a non-success terminal status.
    const sessionId = "10101010-1010-1010-1010-101010101010";
    const process = fakeProcess([
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "partial answer" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: true, session_id: sessionId }),
    ]);
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of runtime.run(
          request("streams-then-fails", { mode: "new" }),
          context,
        ))
          events.push(event);
      })(),
    ).rejects.toThrow(/claude turn failed/);

    expect(events.filter((event) => (event as { type?: string }).type === "text")).toEqual([
      { type: "text", text: "partial answer" },
    ]);
    expect(events.some((e) => (e as { type?: string }).type === "done")).toBe(false);
  });

  it("reports the native exit when claude ends before the result event", async () => {
    const sessionId = "55555555-5555-5555-5555-555555555555";
    const process: NativeProcess = {
      write: async () => undefined,
      stdout: (async function* () {
        yield `${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`;
      })(),
      stderr: (async function* () {})(),
      wait: async () => ({ code: 17 }),
      stop: async () => "stopped",
    };
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess: async () => process } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });

    await expect(
      (async () => {
        for await (const _event of runtime.run(request("ends-early", { mode: "new" }), context))
          undefined;
      })(),
    ).rejects.toThrow(/ended before turn completion \(exit code 17\)/);
  });

  it("refuses a choice other than claude-native without any success fallback", async () => {
    const startNativeProcess = vi.fn();
    const runtime = new ClaudeNativeRuntime({
      sandbox: { startNativeProcess } as unknown as SandboxProvider,
      computer,
      cwd: ".",
    });
    const codexRequest = request("wrong-choice", { mode: "new" });
    codexRequest.execution!.choice = { harness: "codex-native", targetId: "computer" };

    await expect(
      (async () => {
        for await (const _event of runtime.run(codexRequest, context)) undefined;
      })(),
    ).rejects.toThrow(/claude-native was not selected/);
    expect(startNativeProcess).not.toHaveBeenCalled();
  });
});
