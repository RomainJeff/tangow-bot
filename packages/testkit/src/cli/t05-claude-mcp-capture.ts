import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { AgentRunRequest, NativeProcess, SandboxProvider } from "@rakazo/adapter-kit";
import { NATIVE_MCP_RELAY_URL } from "@rakazo/core";
import { nativeProcessSchema } from "../../../../infra/sandboxes/supervisor/src/native-process-schema.js";
import { ClaudeNativeRuntime } from "../../../adapters/src/claude-native-runtime.js";

console.log(`CAPTURE_NODE=${process.version}`);
if (process.versions.node.split(".")[0] !== "22") throw new Error("Node 22 required");
const output = process.argv[2];
if (!output) throw new Error("An isolated output path is required");

const ticket = randomBytes(32).toString("hex");
const request: AgentRunRequest = {
  botId: "probe",
  threadId: "probe",
  runId: "probe",
  prompt: "Reply with OK.",
  instructions: Array.from(
    { length: 24 },
    (_, index) =>
      `Workspace task ${index + 1}: Inspect the existing files before editing. Use the Computer for commands and file changes. Route external actions through Rakazo tools and respect their approvals. Report verification results and unresolved limitations.\n`,
  ).join(""),
  history: [],
  tools: [],
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    // In-memory fixture only; neither this value nor the runtime env is serialized.
    oauth: {
      credential: { type: "oauth", access: "offline-fixture", refresh: "", expires: 0 },
      refresh: async (credential) => credential,
    },
  },
  execution: {
    choice: { harness: "claude-native", targetId: "probe" },
    authority: { runId: "probe", attemptId: "probe", fence: 1, policyRevision: 1 },
    continuity: { mode: "new" },
    computerId: "probe",
    contextRevision: 0,
  },
};
let invocation: { argv: string[]; files: unknown; stdin?: string } | undefined;
const nativeProcess: NativeProcess = {
  write: async (stdin) => {
    if (!invocation) throw new Error("Missing native invocation");
    invocation.stdin = stdin;
  },
  stdout: (async function* () {
    yield '{"type":"system","subtype":"init","session_id":"probe","mcp_servers":[{"name":"rakazo","status":"connected"}]}';
    yield '{"type":"result","subtype":"success"}';
  })(),
  stderr: (async function* () {})(),
  wait: async () => ({ code: 0 }),
  stop: async () => "stopped",
};
const sandbox = {
  startNativeProcess: async (_computer, nativeRequest) => {
    nativeProcessSchema.parse(nativeRequest);
    console.log("J3D2F_SUPERVISOR_SCHEMA_ACCEPTS=yes");
    invocation = { argv: nativeRequest.argv, files: nativeRequest.files };
    return nativeProcess;
  },
} satisfies Pick<SandboxProvider, "startNativeProcess">;
const runtime = new ClaudeNativeRuntime(
  {
    sandbox: sandbox as SandboxProvider,
    computer: { id: "probe", providerRef: "probe", botId: "probe", kind: "docker" },
    cwd: ".",
  },
  {
    toolServer: async () => ({
      ticket,
      endpoint: {
        url: NATIVE_MCP_RELAY_URL,
        httpHeaders: { Authorization: `Bearer ${ticket}` },
      },
      close: async () => {},
    }),
  },
);
for await (const _event of runtime.run(request, {
  operationId: "probe",
  traceId: "probe",
  spaceId: "probe",
  userId: "probe",
  signal: new AbortController().signal,
})) {
  // Capture the actual product argv, config bytes and stdin, without running a provider.
}
if (!invocation?.stdin) throw new Error("Runtime did not write its input");
await writeFile(output, JSON.stringify({ ...invocation, relayUrl: NATIVE_MCP_RELAY_URL }), {
  mode: 0o600,
});
console.log("RUNTIME_INVOCATION_CAPTURED=yes");
