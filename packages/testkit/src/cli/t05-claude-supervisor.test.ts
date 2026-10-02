import type {
  AdapterContext,
  AgentRunRequest,
  ComputerRef,
  NativeProcess,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { nativeProcessSchema } from "../../../../infra/sandboxes/supervisor/src/native-process-schema.js";
import { ClaudeNativeRuntime } from "../../../adapters/src/claude-native-runtime.js";

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

function fakeProcess(lines: string[]): NativeProcess {
  return {
    write: async () => {},
    stdout: (async function* () {
      for (const line of lines) yield `${line}\n`;
    })(),
    stderr: (async function* () {})(),
    wait: async () => ({ code: 0 }),
    stop: async () => "stopped",
  };
}
function request(
  runId: string,
  continuity: NonNullable<AgentRunRequest["execution"]>["continuity"],
  overrides: { instructions: string },
): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId,
    prompt: "hello",
    instructions: overrides.instructions,
    history: [],
    tools: [],
    model: {
      provider: "anthropic",
      id: "claude-sonnet",
      oauth: {
        credential: { type: "oauth", access: "offline-fixture", refresh: "", expires: 0 },
        refresh: async (credential) => credential,
      },
    },
    execution: {
      choice: { harness: "claude-native", targetId: "computer" },
      authority: { runId, attemptId: "attempt", fence: 1, policyRevision: 1 },
      continuity,
      computerId: "computer",
    },
  };
}

describe("Claude runtime and supervisor contract", () => {
  it("passes the supervisor schema with a private long prompt, MCP, resume and allowed tools", async () => {
    const sessionId = "00000000-0000-0000-0000-000000000042";
    const instructions = Array.from(
      { length: 24 },
      (_, index) =>
        `Workspace task ${index + 1}: Inspect the existing files before editing. Use the Computer for commands and file changes. Route external actions through Rakazo tools and respect their approvals. Report verification results and unresolved limitations.\n`,
    ).join("");
    expect(Buffer.byteLength(instructions)).toBeGreaterThanOrEqual(4_096);
    const process = fakeProcess([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        mcp_servers: [{ name: "rakazo", status: "connected" }],
      }),
      '{"type":"result","subtype":"success"}',
    ]);
    const startNativeProcess = vi.fn<NonNullable<SandboxProvider["startNativeProcess"]>>(
      async () => process,
    );
    const runtime = new ClaudeNativeRuntime(
      { sandbox: { startNativeProcess } as unknown as SandboxProvider, computer, cwd: "." },
      {
        toolServer: async () => ({
          ticket: "test-ticket",
          endpoint: {
            url: "http://rakazo-mcp:7091/native-mcp",
            httpHeaders: { Authorization: "Bearer test-ticket" },
          },
          close: async () => {},
        }),
      },
    );
    for await (const _event of runtime.run(
      request(
        "long-prompt",
        {
          mode: "resume",
          ref: { bindingId: "thread", generation: 0 },
          inputId: "input-1",
          nativeRef: sessionId,
        },
        { instructions },
      ),
      context,
    ))
      undefined;

    const nativeRequest = startNativeProcess.mock.calls[0]![1];
    expect(() => nativeProcessSchema.parse(nativeRequest)).not.toThrow();
    const home = nativeRequest.env?.CLAUDE_CONFIG_DIR;
    expect(nativeRequest.argv).not.toContain("--append-system-prompt");
    expect(nativeRequest.argv.join(" ")).not.toContain("Workspace task");
    expect(nativeRequest.argv).toContain("--append-system-prompt-file");
    expect(nativeRequest.argv).toContain(`${home}/system-prompt.md`);
    expect(nativeRequest.argv).toContain("--resume");
    expect(nativeRequest.argv).toContain(sessionId);
    expect(nativeRequest.argv).toContain("mcp__rakazo,Bash,Edit,Write,NotebookEdit");
    expect(nativeRequest.files).toContainEqual({ path: "system-prompt.md", content: instructions });
    expect(nativeRequest.files?.map((file) => file.path).sort()).toEqual([
      "mcp-config.json",
      "system-prompt.md",
    ]);
  });
});
