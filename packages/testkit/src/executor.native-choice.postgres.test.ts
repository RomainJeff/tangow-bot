import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ComputerRef,
  ConnectorEvent,
  Continuity,
  NativeProcess,
  NativeProcessRequest,
} from "@rakazo/adapter-kit";
import type { ExecutorDeps } from "@rakazo/adapters";
import {
  ComposioEmulator,
  createRunExecutor,
  EncryptedSecretStore,
  FakeSandboxProvider,
  LocalAgentHomeStore,
} from "@rakazo/adapters";
import type { AuthorizedActor, CommandContext, ThreadSnapshot } from "@rakazo/contracts";
import { RUN_CHOICE_VERSION } from "@rakazo/contracts";
import { createDb, createThreadEvents } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listSpaceRuns } from "../../../apps/api/src/runs.ts";
import { messageBot } from "../../adapters/src/bot-messages.ts";
import { createDelegatedTasks } from "../../adapters/src/delegated-tasks.ts";
import { createNativeSessionHost } from "../../adapters/src/native-session-host.ts";
import { createNativeSessionStore } from "../../adapters/src/native-session-store.ts";
import { createNativeMcpHttpServer } from "../../adapters/src/rakazo-mcp-http.ts";
import { MarkdownMemoryStore } from "../../memory/src/index.js";
import { sessionCookieHeader } from "./index.ts";
import { startModelEmulator } from "./model-emulator.ts";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

/** A native harness seam: it retains a parked process by its public binding. */
class ParkedCodex implements AgentRuntime {
  readonly continuities: Continuity[] = [];
  starts = 0;
  private readonly parked = new Set<string>();

  constructor(private readonly beforeSession: () => Promise<void> = async () => undefined) {}

  describe() {
    return {
      id: "codex-native",
      contractVersion: "1",
      adapterVersion: "test",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: false },
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    const continuity = request.execution!.continuity;
    this.continuities.push(continuity);
    const parked =
      continuity.mode === "resume" &&
      this.parked.delete(`${continuity.ref.bindingId}:${continuity.ref.generation}`);
    const binding =
      continuity.mode === "resume" && !parked
        ? { bindingId: continuity.ref.bindingId, generation: continuity.ref.generation + 1 }
        : continuity.mode === "resume"
          ? continuity.ref
          : continuity.mode === "reconstruct"
            ? {
                bindingId: continuity.previous.bindingId,
                generation: continuity.previous.generation + 1,
              }
            : (continuity.ref ?? { bindingId: request.runId, generation: 0 });
    const key = `${binding.bindingId}:${binding.generation}`;
    const resumed = continuity.mode === "resume" && parked;
    if (!resumed) this.starts += 1;
    await this.beforeSession();
    yield {
      type: "native",
      event: {
        type: "session",
        ref: binding,
        continuity: resumed
          ? "resumed"
          : continuity.mode === "reconstruct" || continuity.mode === "resume"
            ? "reconstructed"
            : "new",
        nativeRef: "fake-codex-thread",
      },
    };
    yield { type: "done", text: "done" };
    this.parked.add(key);
  }

  clearParked() {
    this.parked.clear();
  }
}

/** Claude's fake CLI contract: a restarted process must receive its stored CLI session. */
class ParkedClaude implements AgentRuntime {
  readonly continuities: Continuity[] = [];
  readonly commands: string[][] = [];
  readonly configDirs: string[] = [];

  describe() {
    return {
      id: "claude-native",
      contractVersion: "1",
      adapterVersion: "test",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: false },
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    const continuity = request.execution!.continuity;
    this.continuities.push(continuity);
    const binding =
      continuity.mode === "reconstruct"
        ? {
            bindingId: continuity.previous.bindingId,
            generation: continuity.previous.generation + 1,
          }
        : continuity.mode === "new"
          ? continuity.ref!
          : continuity.ref;
    this.configDirs.push(`/tmp/fake-claude-${binding.bindingId}`);
    if (continuity.mode === "resume" || continuity.mode === "reconstruct") {
      if (!continuity.nativeRef) throw new Error("fake Claude requires --resume session id");
      this.commands.push(["claude", "--resume", continuity.nativeRef]);
    }
    yield {
      type: "native",
      event: {
        type: "session",
        ref: binding,
        nativeRef: "fake-claude-session",
        continuity:
          continuity.mode === "resume"
            ? "resumed"
            : continuity.mode === "reconstruct"
              ? "reconstructed"
              : "new",
      },
    };
    yield { type: "done", text: "done" };
  }
}

class SessionThenFailure implements AgentRuntime {
  readonly aborts: string[] = [];
  readonly purges: string[] = [];

  constructor(private readonly abortFails = false) {}
  describe() {
    return {
      id: "codex-native",
      contractVersion: "1",
      adapterVersion: "test",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: false },
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    const ref =
      request.execution!.continuity.mode === "new"
        ? request.execution!.continuity.ref!
        : request.execution!.continuity.ref;
    yield {
      type: "native",
      event: { type: "session", ref, continuity: "new", nativeRef: "fake-codex-thread" },
    };
    throw new Error("scripted native failure");
  }

  async abort(runId: string) {
    this.aborts.push(runId);
    if (this.abortFails) throw new Error("native stop is unconfirmed");
  }

  async purgeNativeHome(runId: string) {
    this.purges.push(runId);
  }
}

class MissingRolloutAfterComputerLoss implements AgentRuntime {
  readonly purges: string[] = [];

  describe() {
    return {
      id: "codex-native",
      contractVersion: "1",
      adapterVersion: "test",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: false },
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    const continuity = request.execution!.continuity;
    if (continuity.mode !== "reconstruct") throw new Error("expected reconstruction");
    yield {
      type: "native",
      event: {
        type: "error",
        ref: continuity.previous,
        reason: "resume_rollout_missing",
      },
    };
    yield {
      type: "native",
      event: {
        type: "closed",
        ref: {
          bindingId: continuity.previous.bindingId,
          generation: continuity.previous.generation + 1,
        },
        processState: "stopped",
      },
    };
    throw Object.assign(new Error("codex_native_rollout_missing"), { code: "harness_unavailable" });
  }

  async abort() {}

  async purgeNativeHome(runId: string) {
    this.purges.push(runId);
  }
}

class SessionThenDone implements AgentRuntime {
  readonly aborts: string[] = [];

  constructor(private readonly beforeDone: () => Promise<void> = async () => undefined) {}

  describe() {
    return {
      id: "codex-native",
      contractVersion: "1",
      adapterVersion: "test",
      capabilities: { streaming: true, compaction: false, tools: false, scripted: false },
    };
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
    const ref =
      request.execution!.continuity.mode === "new"
        ? request.execution!.continuity.ref!
        : request.execution!.continuity.ref;
    yield {
      type: "native",
      event: { type: "session", ref, continuity: "new", nativeRef: "fake-codex-thread" },
    };
    await this.beforeDone();
    yield { type: "done", text: "done" };
  }

  async abort(runId: string) {
    this.aborts.push(runId);
  }
}

async function waitForPublicTerminalRun(
  prisma: Parameters<typeof listSpaceRuns>[0],
  actor: Parameters<typeof listSpaceRuns>[1],
  runId: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const recent = await listSpaceRuns(prisma, actor, "recent");
    const terminal = recent.find((row) => row.runId === runId);
    if (terminal) return terminal;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for public terminal status for ${runId}`);
}

/** Keep fake-runtime tests on a compatible configured provider at API admission. */
async function configureNativeFixture(
  prisma: Parameters<typeof createRunExecutor>[0]["prisma"],
  botId: string,
  provider = "openai-codex",
) {
  const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
  const existing = await prisma.userModelCredential.findFirstOrThrow({
    where: { userId: bot.userId },
  });
  const credential = await prisma.userModelCredential.create({
    data: {
      userId: bot.userId,
      provider,
      label: "Native fixture",
      secretId: existing.secretId,
    },
  });
  const modelId = provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.6";
  await prisma.spaceModelPreference.create({
    data: {
      userId: bot.userId,
      spaceId: bot.spaceId,
      credentialId: credential.id,
      modelId,
    },
  });
  await prisma.bot.update({ where: { id: botId }, data: { modelProvider: provider, modelId } });
}

async function startNativeHarness(
  runtime: AgentRuntime | undefined,
  label: string,
  options: { sandbox?: FakeSandboxProvider; claudeRuntime?: AgentRuntime } = {},
) {
  const { sandbox, claudeRuntime } = options;
  const model = await startModelEmulator({ apiKey: "test-key", steps: [] });
  const dataDir = await mkdtemp(path.join(tmpdir(), `rakazo-native-${label}-`));
  const { createApp } = await import("../../../apps/api/src/app.ts");
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    realtimeDatabaseUrl: process.env.DATABASE_URL!,
    authUrl: origin,
    webOrigin: origin,
    dataDir,
    sandboxProvider: "fake",
    agentRuntime: "scripted",
    wakeupDriver: "graphile",
    signupsEnabled: "true",
    composio: new ComposioEmulator(),
    encryptionKey: "native-test-encryption-key",
    ...(runtime || claudeRuntime
      ? {
          nativeRuntimes: {
            ...(runtime ? { "codex-native": runtime } : {}),
            ...(claudeRuntime ? { "claude-native": claudeRuntime } : {}),
          },
        }
      : {}),
    ...(sandbox ? { sandbox } : {}),
  });
  const signup = await handles.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: `${label}-${randomUUID()}@rakazo.test`,
      password: "password12",
      name: "Native test",
    }),
  });
  const cookie = sessionCookieHeader(signup);
  const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: input }),
    });
    const body = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || body.error)
      throw new Error(
        body.error?.message ??
          (body.json as { message?: string })?.message ??
          `${procedure} failed`,
      );
    return body.json as T;
  };
  await rpc("models/connect", {
    provider: model.model.provider,
    modelId: model.model.id,
    baseUrl: model.baseUrl,
    apiKey: "test-key",
  });
  const bot = await rpc<{ id: string }>("bots/create", {
    name: "Native test",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await rpc("bots/update", {
    botId: bot.id,
    modelProvider: model.model.provider,
    modelId: model.model.id,
  });
  if (runtime) await configureNativeFixture(handles.prisma, bot.id);
  const computer = (
    await handles.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { computer: true },
    })
  ).computer!;
  const send = (text: string) =>
    rpc<{ runId: string }>("threads/send", {
      botId: bot.id,
      text,
      harness: "codex-native",
      executionTarget: computer.id,
    });
  return { handles, model, dataDir, bot, computer, rpc, send };
}

async function stopNativeHarness(harness: Awaited<ReturnType<typeof startNativeHarness>>) {
  await harness.handles.stop();
  await harness.model.close();
  await rm(harness.dataDir, { recursive: true, force: true });
}

async function seedUnconfirmedNativeSession(
  harness: Awaited<ReturnType<typeof startNativeHarness>>,
  processRef?: string,
) {
  const receipt = await harness.send("recover an unconfirmed native process");
  const run = await harness.handles.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } });
  await harness.handles.prisma.nativeSession.create({
    data: {
      botId: harness.bot.id,
      threadId: run.threadId,
      generation: 0,
      nativeRef: "surviving-native-thread",
      ...(processRef ? { processRef } : {}),
      harness: "codex-native",
      executionTarget: harness.computer.id,
      state: "expired",
      processState: "stop_unconfirmed",
    },
  });
  return { receipt, run };
}

describe.skipIf(!available)("native runtime choice", () => {
  it.each(["claude-native", "codex-native"] as const)(
    "refuses incompatible %s at send with the saved-choice error and no run",
    async (harness) => {
      const h = await startNativeHarness(undefined, "send-refusal");
      try {
        const expected = `Choosing ${
          harness === "claude-native" ? "Claude" : "Codex"
        } requires the bot's effective model to use its connected subscription`;
        await expect(h.rpc("bots/update", { botId: h.bot.id, harness })).rejects.toThrow(expected);
        for (const inherited of [false, true]) {
          if (inherited)
            await h.handles.prisma.bot.update({
              where: { id: h.bot.id },
              data: { modelProvider: null, modelId: null },
            });
          await expect(
            h.rpc("threads/send", {
              botId: h.bot.id,
              text: "refuse me",
              harness,
              executionTarget: h.computer.id,
            }),
          ).rejects.toThrow(expected);
          expect(await h.handles.prisma.run.count({ where: { botId: h.bot.id } })).toBe(0);
        }
        await h.handles.prisma.bot.update({
          where: { id: h.bot.id },
          data: { harnessChoice: harness },
        });
        await expect(
          h.rpc("threads/send", { botId: h.bot.id, text: "stale saved choice" }),
        ).rejects.toThrow(expected);
        expect(await h.handles.prisma.run.count({ where: { botId: h.bot.id } })).toBe(0);
      } finally {
        await stopNativeHarness(h);
      }
    },
  );

  it.each([
    { harnessName: "codex-native", resume: false, rights: false },
    { harnessName: "claude-native", resume: false, rights: false },
    { harnessName: "claude-native", resume: true, rights: false },
    { harnessName: "claude-native", resume: true, rights: true },
  ] as const)(
    "executor-built $harnessName: Docker placement, sanitized failure or two-turn resume=$resume rights=$rights",
    async ({ harnessName, resume, rights }) => {
      let callMcp = async (_request: NativeProcessRequest) => {};
      const outcomes: unknown[] = [];
      const executed: string[] = [];
      const dockerId = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
      const detail = "Fable 5.1 requires usage credits. Switch to another model to continue.";
      const provider = harnessName === "codex-native" ? "openai-codex" : "anthropic";
      const modelId = harnessName === "codex-native" ? "gpt-5.6" : "claude-sonnet-4-6";
      const startNativeProcess = vi.fn(
        async (_computer: ComputerRef, _request: NativeProcessRequest): Promise<NativeProcess> => ({
          write: async () => {
            if (harnessName === "codex-native") throw new Error("fixture stops after arm");
          },
          stdout: (async function* () {
            await callMcp(_request);
            yield JSON.stringify({
              type: "system",
              subtype: "init",
              session_id: "fake-cli-session",
              mcp_servers: [{ name: "rakazo", status: "connected" }],
            });
            if (resume) {
              yield JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "OK" }] },
              });
              yield JSON.stringify({
                type: "result",
                subtype: "success",
                is_error: false,
                terminal_reason: "completed",
                session_id: "fake-cli-session",
                result: "OK",
              });
              return;
            }
            yield JSON.stringify({
              type: "assistant",
              error: "rate_limit",
              apiError: "model_requires_usage_credits",
              message: { content: [{ type: "text", text: `${detail} fake-access` }] },
              request_id: "req_private_fixture",
            });
            yield JSON.stringify({ type: "result", subtype: "success", is_error: true });
          })(),
          stderr: (async function* () {})(),
          wait: async () => ({ code: 1 }),
          stop: async () => "stopped",
        }),
      );
      class NativeSandbox extends FakeSandboxProvider {
        startNativeProcess = startNativeProcess;
        override async provision(
          request: { botId: string; homePath: string },
          context: AdapterContext,
        ) {
          const original = await super.provision(request, context);
          const box = this.boxes.get(original.id)!;
          const ref: ComputerRef = {
            ...original,
            id: dockerId,
            providerRef: dockerId,
            kind: "docker",
          };
          this.boxes.delete(original.id);
          this.boxes.set(dockerId, { ...box, ref });
          return ref;
        }
      }
      const sandbox = new NativeSandbox();
      const h = await startNativeHarness(undefined, `placement-${harnessName}`, { sandbox });
      const db = rights ? createDb(process.env.DATABASE_URL!) : undefined;
      const mcp = db
        ? createNativeMcpHttpServer({
            host: createNativeSessionHost(db.pool),
            relaySecret: "fake-relay-secret",
          })
        : undefined;
      try {
        const me = await h.rpc<Parameters<typeof listSpaceRuns>[1]>("me", {});
        const secretStore = new EncryptedSecretStore("native-test-encryption-key");
        const secretId = randomUUID();
        const encrypted = await secretStore.put(
          JSON.stringify({
            type: "oauth",
            access: "fake-access",
            refresh: "fake-refresh",
            expires: Date.now() + 3_600_000,
            accountId: "fake-account",
          }),
          {
            operationId: "fixture",
            traceId: "fixture",
            ...me,
            signal: new AbortController().signal,
          },
          secretId,
        );
        await h.handles.prisma.secret.create({
          data: {
            id: secretId,
            userId: me.userId,
            kind: "model",
            ciphertext: encrypted.ciphertext,
          },
        });
        const credential = await h.handles.prisma.userModelCredential.create({
          data: {
            userId: me.userId,
            provider,
            label: "Native fixture",
            secretId,
          },
        });
        await h.handles.prisma.spaceModelPreference.create({
          data: { userId: me.userId, spaceId: me.spaceId, credentialId: credential.id, modelId },
        });
        await h.handles.prisma.bot.update({
          where: { id: h.bot.id },
          data: { modelProvider: provider, modelId },
        });
        let work: { runId?: string | null } | undefined;
        let serverId = "";
        if (rights) {
          const server = await h.handles.prisma.mcpServer.create({
            data: {
              spaceId: me.spaceId,
              userId: me.userId,
              slug: randomUUID(),
              name: "Fixture",
              transport: "stdio",
              enabled: true,
            },
          });
          serverId = server.id;
          await h.handles.prisma.botMcpServer.create({
            data: {
              spaceId: me.spaceId,
              userId: me.userId,
              botId: h.bot.id,
              serverId,
              allowAllTools: true,
            },
          });
          const profile = await h.handles.prisma.bot.create({
            data: {
              spaceId: me.spaceId,
              userId: me.userId,
              name: "Profile",
              color: "test-color",
              modelProvider: provider,
              modelId,
            },
          });
          await h.handles.prisma.botMcpServer.create({
            data: {
              spaceId: me.spaceId,
              userId: me.userId,
              botId: profile.id,
              serverId,
              allowAllTools: true,
            },
          });
          const parent = await h.rpc<{ runId: string }>("threads/send", {
            botId: h.bot.id,
            text: "delegate",
          });
          work = await createDelegatedTasks({
            prisma: h.handles.prisma,
            jobs: h.handles.jobs,
          }).apply(
            {
              kind: "delegate",
              target: { kind: "from_profile", profileBotId: profile.id, name: "Specialist" },
              harness: "claude-native",
              brief: "search only",
              spawnKey: randomUUID(),
              requestedRights: { [serverId]: { allowAllTools: false, allowedTools: ["search"] } },
            },
            {
              actor: { ...me, botId: h.bot.id, rights: {} },
              originRunId: parent.runId,
              requestId: randomUUID(),
            },
          );
          const listener = await mcp!.listen(0);
          const address = listener.address();
          if (!address || typeof address === "string") throw new Error("missing listener");
          const url = `http://127.0.0.1:${address.port}/native-mcp`;
          callMcp = async (request) => {
            const config = JSON.parse(
              request.files!.find((file) => file.path === "mcp-config.json")!.content,
            );
            const headers: Record<string, string> = {
              ...config.mcpServers.rakazo.headers,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "x-rakazo-relay-secret": "fake-relay-secret",
              "x-rakazo-source-computer": dockerId,
            };
            const post = (body: unknown) =>
              fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
            const init = await post({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "fake-cli", version: "1" },
              },
            });
            headers["mcp-session-id"] = init.headers.get("mcp-session-id")!;
            await init.text();
            for (const [index, name] of ["mcp_fixture_write", "mcp_fixture_search"].entries()) {
              const response = await post({
                jsonrpc: "2.0",
                id: index + 2,
                method: "tools/call",
                params: { name, arguments: {} },
              });
              const text = await response.text();
              outcomes.push(
                JSON.parse(text.startsWith("event:") ? text.match(/^data: (.+)$/m)![1]! : text),
              );
            }
          };
        }
        const arm = vi.fn<NonNullable<ExecutorDeps["nativeMcp"]>["arm"]>(async () => undefined);
        // Construct the worker's executor directly: the API fixture has no MCP injection seam.
        // No nativeRuntimes override; both real runtime constructors and toolServer execute.
        const executor = createRunExecutor({
          prisma: h.handles.prisma,
          jobs: h.handles.jobs,
          runtime: h.handles.runtime,
          sandbox,
          home: new LocalAgentHomeStore(h.dataDir),
          dataDir: h.dataDir,
          memory: new MarkdownMemoryStore(h.handles.prisma),
          memoryProviders: { resolve: async () => null },
          connector: rights
            ? {
                describe: () => h.handles.connector.describe(),
                discoverTools: async () =>
                  ["search", "write"].map((name) => ({
                    name: `mcp_fixture_${name}`,
                    description: name,
                    inputSchema: { type: "object", properties: {} },
                    readOnly: true,
                    route: { connectorId: "mcp", resourceId: serverId, toolName: name },
                  })),
                async *execute(call): AsyncIterable<ConnectorEvent> {
                  executed.push(call.tool);
                  yield { type: "result", data: { executed: call.tool } };
                },
              }
            : h.handles.connector,
          events: createThreadEvents(h.handles.prisma),
          secretStore,
          secrets: [],
          modelOAuth: {
            refresh: async (_provider, value) => value,
            toAuth: async () => "fake-access",
          },
          nativeMcp: mcp ?? {
            issue: async ({ botId, threadId }) => {
              await h.handles.prisma.nativeSession.upsert({
                where: { botId_threadId: { botId, threadId } },
                create: { botId, threadId },
                update: {},
              });
              return {
                ticket: "fake-ticket",
                endpoint: {
                  url: "http://rakazo-mcp:7091/native-mcp",
                  httpHeaders: { Authorization: "Bearer fake-ticket" },
                },
                close: async () => undefined,
              };
            },
            arm,
            disarm: async () => undefined,
          },
        });
        const receipt = work?.runId
          ? { runId: work.runId }
          : await h.rpc<{ runId: string }>("threads/send", {
              botId: h.bot.id,
              text: "exercise native placement",
              harness: harnessName,
              executionTarget: h.computer.id,
            });
        await executor.continueRun(receipt.runId, "native-placement-worker");
        const terminal = await waitForPublicTerminalRun(h.handles.prisma, me, receipt.runId);
        if (rights) {
          expect(terminal).toMatchObject({ status: "completed" });
          expect(outcomes[0]).toMatchObject({
            result: { isError: true, content: [{ text: "tool_not_allowed" }] },
          });
          expect(outcomes[1]).toMatchObject({
            result: { content: [{ text: expect.stringContaining("mcp_fixture_search") }] },
          });
          expect(executed).toEqual(["mcp_fixture_search"]);
          return;
        }
        if (resume) {
          expect(terminal).toMatchObject({ status: "completed" });
          await expect(
            h.handles.prisma.nativeSession.findFirstOrThrow({ where: { botId: h.bot.id } }),
          ).resolves.toMatchObject({
            state: "parked",
            processState: "stopped",
            nativeRef: "fake-cli-session",
          });
          const second = await h.rpc<{ runId: string }>("threads/send", {
            botId: h.bot.id,
            text: "continue this same conversation",
            harness: harnessName,
            executionTarget: h.computer.id,
          });
          await executor.continueRun(second.runId, "native-placement-worker");
          expect(await waitForPublicTerminalRun(h.handles.prisma, me, second.runId)).toMatchObject({
            status: "completed",
          });
          expect(startNativeProcess).toHaveBeenCalledTimes(2);
          const firstArgv = startNativeProcess.mock.calls[0]![1].argv;
          const secondArgv = startNativeProcess.mock.calls[1]![1].argv;
          expect(firstArgv).not.toContain("--resume");
          expect(
            secondArgv.slice(secondArgv.indexOf("--resume"), secondArgv.indexOf("--resume") + 2),
          ).toEqual(["--resume", "fake-cli-session"]);
          return;
        }
        expect(terminal).toMatchObject({ status: "failed" });
        const snapshot = await h.rpc<ThreadSnapshot>("threads/get", { botId: h.bot.id });
        expect(snapshot.run).toMatchObject({
          status: "failed",
          error:
            harnessName === "claude-native"
              ? `claude turn failed: rate_limit: ${detail} [redacted]`
              : "fixture stops after arm",
        });
        expect(startNativeProcess).toHaveBeenCalledOnce();
        expect(startNativeProcess.mock.calls[0]![0]).toMatchObject({
          id: dockerId,
          providerRef: dockerId,
        });
        expect(arm).toHaveBeenCalledOnce();
        expect(arm.mock.calls[0]![1].computerId).toBe(dockerId);
        expect(arm.mock.calls[0]![1].computerId).not.toBe(h.computer.id);
      } finally {
        await mcp?.close();
        await db?.prisma.$disconnect();
        await db?.pool.end();
        await stopNativeHarness(h);
      }
    },
    30_000,
  );

  it("returns an open specialist's peer-awakened run to its coordinator through the executor", async () => {
    const runtime = new SessionThenDone();
    const harness = await startNativeHarness(runtime, "scenario2-peer-return");
    try {
      const me = await harness.rpc<{ userId: string; spaceId: string }>("me", {});
      await harness.handles.prisma.bot.update({
        where: { id: harness.bot.id },
        data: { modelProvider: "openai-codex", modelId: "gpt-5.6", thinkingLevel: "low" },
      });
      const coordinator = await harness.handles.prisma.bot.create({
        data: {
          spaceId: me.spaceId,
          userId: me.userId,
          name: "Coordinator",
          color: "test-color",
          computerId: harness.computer.id,
        },
      });
      const coordinatorThread = await harness.handles.prisma.thread.create({
        data: { spaceId: me.spaceId, userId: me.userId, botId: coordinator.id },
      });
      const originTask = await harness.handles.prisma.task.create({
        data: {
          spaceId: me.spaceId,
          userId: me.userId,
          botId: coordinator.id,
          threadId: coordinatorThread.id,
          prompt: "delegate",
          status: "running",
        },
      });
      const originRun = await harness.handles.prisma.run.create({
        data: {
          spaceId: me.spaceId,
          userId: me.userId,
          botId: coordinator.id,
          threadId: coordinatorThread.id,
          taskId: originTask.id,
          status: "running",
          trigger: "user",
        },
      });
      const actor: AuthorizedActor = {
        userId: me.userId,
        spaceId: me.spaceId,
        botId: coordinator.id,
        rights: { canReadFiles: true },
      };
      const context: CommandContext = {
        actor,
        originRunId: originRun.id,
        requestId: randomUUID(),
      };
      const tasks = createDelegatedTasks({
        prisma: harness.handles.prisma,
        jobs: harness.handles.jobs,
      });
      const work = await tasks.apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: harness.bot.id, name: "Analyst" },
          harness: "codex-native",
          brief: "Prepare the summary",
          // T07:6: requestedRights is an McpAccessCeiling narrowing request now (an old
          // boolean shape here is interpreted as a demand for an MCP server literally named
          // "canReadFiles" and refused, since the coordinator holds no MCP access at all in
          // this fixture). This scenario is about native runtime choice and peer-return
          // delivery, not rights — an empty request keeps the ceiling at the coordinator's
          // (empty) effective access, which is irrelevant to what this test asserts.
          requestedRights: {},
          spawnKey: `scenario2-${randomUUID()}`,
        },
        context,
      );
      const specialist = await harness.handles.prisma.bot.findUniqueOrThrow({
        where: { id: work.botId },
      });
      const peer = await harness.handles.prisma.bot.create({
        data: { spaceId: me.spaceId, userId: me.userId, name: "Peer", color: "test-color" },
      });
      const peerThread = await harness.handles.prisma.thread.create({
        data: { spaceId: me.spaceId, userId: me.userId, botId: peer.id },
      });
      const messageDeps = {
        prisma: harness.handles.prisma,
        jobs: harness.handles.jobs,
        events: { notify: vi.fn().mockResolvedValue(undefined) },
      };

      await harness.handles.prisma.run.update({
        where: { id: work.runId! },
        data: { status: "running" },
      });
      await messageBot(
        messageDeps as unknown as Parameters<typeof messageBot>[0],
        {
          id: work.runId!,
          spaceId: me.spaceId,
          threadId: work.threadId,
          botId: specialist.id,
          userId: me.userId,
        },
        { id: specialist.id, name: specialist.name },
        { bot_id: peer.id, message: "Can you verify the total?", intent: "question" },
      );
      const peerRun = await harness.handles.prisma.run.findFirstOrThrow({
        where: { botId: peer.id, threadId: peerThread.id, trigger: "bot_message" },
        orderBy: { createdAt: "desc" },
      });
      await harness.handles.prisma.run.update({
        where: { id: peerRun.id },
        data: { status: "running" },
      });
      await messageBot(
        messageDeps as unknown as Parameters<typeof messageBot>[0],
        {
          id: peerRun.id,
          spaceId: me.spaceId,
          threadId: peerThread.id,
          botId: peer.id,
          userId: me.userId,
          sourceMessageId: peerRun.sourceMessageId,
        },
        { id: peer.id, name: peer.name },
        { bot_id: specialist.id, message: "The total is verified.", intent: "result" },
      );
      const awakened = await harness.handles.prisma.run.findFirstOrThrow({
        where: {
          botId: specialist.id,
          threadId: work.threadId,
          trigger: "bot_message",
          id: { not: work.runId! },
        },
        orderBy: { createdAt: "desc" },
        include: { sourceMessage: true },
      });

      expect(awakened.scopedTaskId).toBe(work.workId);
      expect(awakened.sourceMessage!.blocks).toEqual([
        expect.objectContaining({ kind: "bot_message_received", purpose: "peer_message" }),
      ]);
      await harness.handles.executor.continueRun(awakened.id, "scenario2-executor-worker");
      await vi.waitFor(async () => {
        await expect(
          harness.handles.prisma.run.findUniqueOrThrow({ where: { id: awakened.id } }),
        ).resolves.toMatchObject({ status: "completed" });
      });
      const returns = await harness.handles.prisma.message.findMany({
        where: { threadId: coordinatorThread.id, role: "bot" },
      });

      expect(returns).toHaveLength(1);
      expect(returns[0]!.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "card",
            lines: expect.arrayContaining([
              { k: "purpose", v: "work_return" },
              { k: "workId", v: work.workId },
            ]),
          }),
        ]),
      );
    } finally {
      await stopNativeHarness(harness);
    }
  }, 30_000);

  it("serves a specialist that runs on Rakazo's own harness through the default runtime", async () => {
    const codex = new ParkedCodex();
    const h = await startNativeHarness(codex, "specialist-on-rakazo");
    try {
      const me = await h.rpc<{ userId: string; spaceId: string }>("me", {});
      const parent = await h.send("delegate the summary");
      const work = await createDelegatedTasks({
        prisma: h.handles.prisma,
        jobs: h.handles.jobs,
      }).apply(
        {
          kind: "delegate",
          target: { kind: "from_profile", profileBotId: h.bot.id, name: "Analyst" },
          harness: "default",
          brief: "Prepare the summary",
          requestedRights: {},
          spawnKey: randomUUID(),
        },
        {
          actor: { ...me, botId: h.bot.id, rights: {} },
          originRunId: parent.runId,
          requestId: randomUUID(),
        },
      );

      await h.handles.executor.continueRun(work.runId!, "specialist-on-rakazo-worker");

      await expect(
        h.handles.prisma.run.findUniqueOrThrow({ where: { id: work.runId! } }),
      ).resolves.toMatchObject({
        status: "completed",
        harness: null,
        executionTarget: null,
        choiceVersion: null,
      });
      await expect(
        h.handles.prisma.scopedTask.findUniqueOrThrow({ where: { id: work.workId } }),
      ).resolves.toMatchObject({ harness: null, executionTarget: null, harnessSource: "explicit" });
      expect(codex.starts).toBe(0);
    } finally {
      await stopNativeHarness(h);
    }
  }, 30_000);

  it("serves a peer request on the recipient's saved harness, not the runtime default", async () => {
    const claude = new ParkedClaude();
    const h = await startNativeHarness(new SessionThenDone(), "peer-request-choice", {
      claudeRuntime: claude,
    });
    try {
      const me = await h.rpc<{ userId: string; spaceId: string }>("me", {});
      const recipient = await h.handles.prisma.bot.create({
        data: {
          spaceId: me.spaceId,
          userId: me.userId,
          name: "Claude recipient",
          color: "test-color",
          computerId: h.computer.id,
          harnessChoice: "claude-native",
          choiceVersion: 1,
        },
      });
      const recipientThread = await h.handles.prisma.thread.create({
        data: { spaceId: me.spaceId, userId: me.userId, botId: recipient.id },
      });
      const sender = await h.send("ask the Claude bot");
      await h.handles.prisma.run.update({
        where: { id: sender.runId },
        data: { status: "running" },
      });
      const senderRun = await h.handles.prisma.run.findUniqueOrThrow({
        where: { id: sender.runId },
      });
      await messageBot(
        {
          prisma: h.handles.prisma,
          jobs: h.handles.jobs,
          events: { notify: vi.fn().mockResolvedValue(undefined) },
        } as unknown as Parameters<typeof messageBot>[0],
        senderRun,
        { id: h.bot.id, name: h.bot.id },
        { bot_id: recipient.id, message: "Please check the total.", intent: "question" },
      );
      const request = await h.handles.prisma.run.findFirstOrThrow({
        where: { botId: recipient.id, threadId: recipientThread.id, trigger: "bot_message" },
      });

      await h.handles.executor.continueRun(request.id, "peer-request-choice-worker");

      expect(claude.continuities).toHaveLength(1);
      await expect(
        h.handles.prisma.run.findUniqueOrThrow({ where: { id: request.id } }),
      ).resolves.toMatchObject({
        harness: "claude-native",
        executionTarget: h.computer.id,
        choiceVersion: RUN_CHOICE_VERSION,
        status: "completed",
      });
    } finally {
      await stopNativeHarness(h);
    }
  }, 30_000);

  it("closes the native session when the user stops an active native turn", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new SessionThenDone(async () => waiting);
    const harness = await startNativeHarness(runtime, "user-stop");
    try {
      const receipt = await harness.send("wait for stop");
      const executing = harness.handles.executor.continueRun(
        receipt.runId,
        "native-user-stop-worker",
      );
      await vi.waitFor(async () => {
        const run = await harness.handles.prisma.run.findUniqueOrThrow({
          where: { id: receipt.runId },
        });
        await expect(
          harness.handles.prisma.nativeSession.findUniqueOrThrow({
            where: { botId_threadId: { botId: harness.bot.id, threadId: run.threadId } },
          }),
        ).resolves.toMatchObject({ state: "attached" });
      });
      await harness.rpc("threads/stop", { botId: harness.bot.id });
      release();
      await executing;
      const run = await harness.handles.prisma.run.findUniqueOrThrow({
        where: { id: receipt.runId },
      });
      const session = await harness.handles.prisma.nativeSession.findUniqueOrThrow({
        where: { botId_threadId: { botId: harness.bot.id, threadId: run.threadId } },
      });

      expect(run.status).toBe("cancelled");
      expect(session).toMatchObject({ state: "closed", processState: "stopped" });
    } finally {
      await stopNativeHarness(harness);
    }
  }, 30_000);

  it("fails closed after an unconfirmed native stop and rejects the next continuity", async () => {
    const runtime = new SessionThenFailure(true);
    const harness = await startNativeHarness(runtime, "stop-unconfirmed");
    try {
      const receipt = await harness.send("fail without a native close");
      await harness.handles.executor.continueRun(receipt.runId, "native-stop-unconfirmed-worker");
      const run = await harness.handles.prisma.run.findUniqueOrThrow({
        where: { id: receipt.runId },
      });
      const session = await harness.handles.prisma.nativeSession.findUniqueOrThrow({
        where: { botId_threadId: { botId: harness.bot.id, threadId: run.threadId } },
      });

      expect(session).toMatchObject({ state: "closed", processState: "stop_unconfirmed" });
      await expect(
        createNativeSessionStore(harness.handles.prisma).continuity({
          botId: harness.bot.id,
          threadId: run.threadId,
          harness: "codex-native",
          executionTarget: session.executionTarget!,
          inputId: "next-turn",
        }),
      ).rejects.toMatchObject({
        code: "harness_unavailable",
        message: "previous_stop_unconfirmed",
      });
    } finally {
      await stopNativeHarness(harness);
    }
  }, 30_000);

  it("reconfirms a referenced unconfirmed stop before reconstructing the next native turn", async () => {
    let observed: { state: string; processState: string } | undefined;
    let observeStopped = async () => undefined;
    const runtime = new ParkedCodex(() => observeStopped());
    const sandbox = new FakeSandboxProvider();
    const reconfirm = vi.fn(async () => "stopped" as const);
    sandbox.reconfirmNativeProcess = reconfirm;
    const harness = await startNativeHarness(runtime, "reconfirm-stopped", { sandbox });
    try {
      const { receipt, run } = await seedUnconfirmedNativeSession(harness, "supervisor-session");
      observeStopped = async () => {
        const session = await harness.handles.prisma.nativeSession.findUniqueOrThrow({
          where: { botId_threadId: { botId: harness.bot.id, threadId: run.threadId } },
        });
        observed = { state: session.state, processState: session.processState };
      };

      await harness.handles.executor.continueRun(receipt.runId, "native-reconfirm-worker");
      await vi.waitFor(() => expect(runtime.continuities).toHaveLength(1));

      expect(runtime.continuities).toEqual([
        {
          mode: "reconstruct",
          previous: { bindingId: run.threadId, generation: 0 },
          reason: "parked_process_missing",
          inputId: expect.any(String),
          nativeRef: "surviving-native-thread",
        },
      ]);
      expect(reconfirm).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "fake" }),
        "supervisor-session",
        expect.any(Object),
      );
      expect(observed).toEqual({ state: "closed", processState: "stopped" });
      await expect(
        harness.handles.prisma.lifecycleEvent.findFirst({
          where: { botId: harness.bot.id, threadId: run.threadId, kind: "stop_confirmed" },
        }),
      ).resolves.not.toBeNull();
      await expect(
        harness.handles.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } }),
      ).resolves.toMatchObject({ status: "completed" });
    } finally {
      await stopNativeHarness(harness);
    }
  }, 30_000);

  it("refuses an unconfirmed referenced stop when the supervisor cannot prove it stopped", async () => {
    const runtime = new ParkedCodex();
    const sandbox = new FakeSandboxProvider();
    const reconfirm = vi.fn(async () => "stop_unconfirmed" as const);
    sandbox.reconfirmNativeProcess = reconfirm;
    const harness = await startNativeHarness(runtime, "reconfirm-unproven", { sandbox });
    try {
      const { receipt, run } = await seedUnconfirmedNativeSession(
        harness,
        "living-supervisor-session",
      );

      await expect(
        harness.handles.executor.continueRun(receipt.runId, "native-reconfirm-worker"),
      ).rejects.toThrow("Run setup failed; retrying");
      await vi.waitFor(() => expect(reconfirm).toHaveBeenCalledOnce());
      await vi.waitFor(async () => {
        await expect(
          harness.handles.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } }),
        ).resolves.toMatchObject({ status: "queued" });
      });

      expect(runtime.starts).toBe(0);
      expect(runtime.continuities).toEqual([]);
      await expect(
        createNativeSessionStore(harness.handles.prisma).continuity({
          botId: harness.bot.id,
          threadId: run.threadId,
          harness: "codex-native",
          executionTarget: harness.computer.id,
          inputId: "next-turn",
        }),
      ).rejects.toMatchObject({
        code: "harness_unavailable",
        message: "previous_stop_unconfirmed",
      });
    } finally {
      await stopNativeHarness(harness);
    }
  }, 30_000);

  it("refuses an unconfirmed stop without a process reference without re-confirming it", async () => {
    const runtime = new ParkedCodex();
    const sandbox = new FakeSandboxProvider();
    const reconfirm = vi.fn(async () => "stopped" as const);
    sandbox.reconfirmNativeProcess = reconfirm;
    const harness = await startNativeHarness(runtime, "reconfirm-missing-ref", { sandbox });
    try {
      const { receipt, run } = await seedUnconfirmedNativeSession(harness);
      await expect(
        harness.handles.prisma.nativeSession.findUniqueOrThrow({
          where: { botId_threadId: { botId: harness.bot.id, threadId: run.threadId } },
        }),
      ).resolves.toMatchObject({ processRef: null, processState: "stop_unconfirmed" });

      await expect(
        harness.handles.executor.continueRun(receipt.runId, "native-reconfirm-worker"),
      ).rejects.toThrow("Run setup failed; retrying");
      await vi.waitFor(async () => {
        await expect(
          harness.handles.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } }),
        ).resolves.toMatchObject({ status: "queued" });
      });

      expect(reconfirm).not.toHaveBeenCalled();
      expect(runtime.starts).toBe(0);
      expect(runtime.continuities).toEqual([]);
      await expect(
        createNativeSessionStore(harness.handles.prisma).continuity({
          botId: harness.bot.id,
          threadId: run.threadId,
          harness: "codex-native",
          executionTarget: harness.computer.id,
          inputId: "next-turn",
        }),
      ).rejects.toMatchObject({
        code: "harness_unavailable",
        message: "previous_stop_unconfirmed",
      });
    } finally {
      await stopNativeHarness(harness);
    }
  }, 30_000);

  it("does not close a newer native session after a stale parking generation", async () => {
    let invalidate = async () => undefined;
    const runtime = new SessionThenDone(() => invalidate());
    const harness = await startNativeHarness(runtime, "stale-park");
    try {
      const receipt = await harness.send("complete with stale parking");
      invalidate = async () => {
        const run = await harness.handles.prisma.run.findUniqueOrThrow({
          where: { id: receipt.runId },
        });
        await harness.handles.prisma.nativeSession.updateMany({
          where: { botId: harness.bot.id, threadId: run.threadId },
          data: { generation: { increment: 1 } },
        });
      };
      await harness.handles.executor.continueRun(receipt.runId, "native-stale-park-worker");
      const run = await harness.handles.prisma.run.findUniqueOrThrow({
        where: { id: receipt.runId },
      });
      const session = await harness.handles.prisma.nativeSession.findUniqueOrThrow({
        where: { botId_threadId: { botId: harness.bot.id, threadId: run.threadId } },
      });

      expect(run.status).toBe("completed");
      expect(runtime.aborts).toContain(receipt.runId);
      expect(session).toMatchObject({ generation: 1, state: "attached", processState: "running" });
    } finally {
      await stopNativeHarness(harness);
    }
  }, 30_000);

  it("closes the durable native session when a scripted runtime fails after session", async () => {
    const model = await startModelEmulator({ apiKey: "test-key", steps: [] });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-native-failure-"));
    const runtime = new SessionThenFailure();
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "graphile",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "native-failure-test-encryption-key",
      nativeRuntimes: { "codex-native": runtime },
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `failure-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Native failure",
        }),
      });
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json?: T; error?: { message?: string } };
        if (!response.ok || body.error)
          throw new Error(
            body.error?.message ??
              (body.json as { message?: string })?.message ??
              `${procedure} failed`,
          );
        return body.json as T;
      };
      await rpc("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: "test-key",
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Native failure",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      await configureNativeFixture(handles.prisma, bot.id);
      const computer = (
        await handles.prisma.bot.findUniqueOrThrow({
          where: { id: bot.id },
          include: { computer: true },
        })
      ).computer!;
      const receipt = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "fail",
        harness: "codex-native",
        executionTarget: computer.id,
      });
      await handles.executor.continueRun(receipt.runId, "native-failure-worker");
      await vi.waitFor(async () => {
        await expect(
          handles.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } }),
        ).resolves.toMatchObject({ status: "failed" });
      });
      const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } });
      const session = await handles.prisma.nativeSession.findUniqueOrThrow({
        where: { botId_threadId: { botId: bot.id, threadId: run.threadId } },
      });

      expect(run.status).toBe("failed");
      expect(session).toMatchObject({ state: "closed", processState: "stopped" });
      expect(runtime.purges).toEqual([receipt.runId]);
    } finally {
      await handles.stop();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("expires and signals a missing rollout after Computer loss instead of starting a new thread", async () => {
    const runtime = new MissingRolloutAfterComputerLoss();
    const harness = await startNativeHarness(runtime, "missing-rollout");
    try {
      const receipt = await harness.send("resume after lost Computer");
      const run = await harness.handles.prisma.run.findUniqueOrThrow({
        where: { id: receipt.runId },
      });
      await harness.handles.prisma.nativeSession.create({
        data: {
          botId: harness.bot.id,
          threadId: run.threadId,
          generation: 0,
          nativeRef: "missing-rollout-thread",
          harness: "codex-native",
          executionTarget: harness.computer.id,
          state: "closed",
          processState: "stopped",
        },
      });

      await harness.handles.executor.continueRun(receipt.runId, "native-missing-rollout-worker");

      await expect(
        harness.handles.prisma.nativeSession.findUniqueOrThrow({
          where: { botId_threadId: { botId: harness.bot.id, threadId: run.threadId } },
        }),
      ).resolves.toMatchObject({ state: "expired", processState: "stopped" });
      await expect(
        harness.handles.prisma.lifecycleEvent.findFirstOrThrow({
          where: { botId: harness.bot.id, threadId: run.threadId, kind: "resume_rollout_missing" },
        }),
      ).resolves.toBeDefined();
      expect(runtime.purges).toEqual([receipt.runId]);
    } finally {
      await stopNativeHarness(harness);
    }
  }, 30_000);

  it("resumes a lost parked process by its native reference without a rebuilt line, and says so once when the reference is gone", async () => {
    const model = await startModelEmulator({ apiKey: "test-key", steps: [] });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-native-continuity-"));
    const runtime = new ParkedCodex();
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "graphile",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "native-continuity-test-encryption-key",
      nativeRuntimes: { "codex-native": runtime },
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `continuity-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Native continuity",
        }),
      });
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json?: T; error?: { message?: string } };
        if (!response.ok || body.error)
          throw new Error(
            body.error?.message ??
              (body.json as { message?: string })?.message ??
              `${procedure} failed`,
          );
        return body.json as T;
      };
      await rpc("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: "test-key",
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Native continuity",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      await configureNativeFixture(handles.prisma, bot.id);
      const computer = (
        await handles.prisma.bot.findUniqueOrThrow({
          where: { id: bot.id },
          include: { computer: true },
        })
      ).computer!;
      const send = async (text: string) =>
        rpc<{ runId: string }>("threads/send", {
          botId: bot.id,
          text,
          harness: "codex-native",
          executionTarget: computer.id,
        });
      const first = await send("first");
      await handles.executor.continueRun(first.runId, "native-choice-worker");
      runtime.clearParked();
      const second = await send("second");
      await handles.executor.continueRun(second.runId, "native-choice-worker");
      const threadId = (await handles.prisma.run.findUniqueOrThrow({ where: { id: first.runId } }))
        .threadId;

      expect(runtime.continuities).toEqual([
        { mode: "new", ref: { bindingId: threadId, generation: 0 } },
        {
          mode: "resume",
          ref: { bindingId: threadId, generation: 0 },
          inputId: expect.any(String),
          nativeRef: "fake-codex-thread",
        },
      ]);
      expect(runtime.continuities[1]).toMatchObject({ ref: { bindingId: expect.any(String) } });
      expect(runtime.starts).toBe(2);
      expect(
        await handles.prisma.nativeSession.findUniqueOrThrow({
          where: { botId_threadId: { botId: bot.id, threadId } },
        }),
      ).toMatchObject({ state: "parked", generation: 1 });
      // Resuming by the native reference lost nothing, so the thread says nothing.
      const rebuiltLines = () =>
        handles.prisma.message.findMany({
          where: { threadId, role: "system" },
          select: { blocks: true },
        });
      await expect(rebuiltLines()).resolves.toEqual([]);
      // Once the reference is gone, the next session starts from the history and says so once.
      await handles.prisma.nativeSession.update({
        where: { botId_threadId: { botId: bot.id, threadId } },
        data: { state: "expired", nativeRef: null },
      });
      const third = await send("third");
      await handles.executor.continueRun(third.runId, "native-choice-worker");
      await expect(rebuiltLines()).resolves.toEqual([{ blocks: [{ kind: "session_rebuilt" }] }]);
    } finally {
      await handles.stop();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("passes the stored Claude session to a second executor turn and preserves its config directory after reconstruction", async () => {
    const runtime = new ParkedClaude();
    const model = await startModelEmulator({ apiKey: "test-key", steps: [] });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-claude-continuity-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "graphile",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "claude-continuity-test-encryption-key",
      nativeRuntimes: { "claude-native": runtime },
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `claude-continuity-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Claude continuity",
        }),
      });
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json?: T; error?: { message?: string } };
        if (!response.ok || body.error)
          throw new Error(
            body.error?.message ??
              (body.json as { message?: string })?.message ??
              `${procedure} failed`,
          );
        return body.json as T;
      };
      await rpc("models/connect", {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        apiKey: "test-key",
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Claude continuity",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-5",
      });
      const computer = (
        await handles.prisma.bot.findUniqueOrThrow({
          where: { id: bot.id },
          include: { computer: true },
        })
      ).computer!;
      const send = (text: string) =>
        rpc<{ runId: string }>("threads/send", {
          botId: bot.id,
          text,
          harness: "claude-native",
          executionTarget: computer.id,
        });

      const first = await send("first Claude turn");
      await handles.executor.continueRun(first.runId, "claude-continuity-worker");
      const second = await send("second Claude turn");
      await handles.executor.continueRun(second.runId, "claude-continuity-worker");
      const threadId = (await handles.prisma.run.findUniqueOrThrow({ where: { id: first.runId } }))
        .threadId;
      await handles.prisma.nativeSession.update({
        where: { botId_threadId: { botId: bot.id, threadId } },
        data: { processState: "stopped" },
      });
      const third = await send("reconstruct Claude turn");
      await handles.executor.continueRun(third.runId, "claude-continuity-worker");

      expect(runtime.commands).toEqual([
        ["claude", "--resume", "fake-claude-session"],
        ["claude", "--resume", "fake-claude-session"],
      ]);
      expect(runtime.continuities).toEqual([
        { mode: "new", ref: { bindingId: threadId, generation: 0 } },
        {
          mode: "resume",
          ref: { bindingId: threadId, generation: 0 },
          inputId: expect.any(String),
          nativeRef: "fake-claude-session",
        },
        {
          mode: "reconstruct",
          previous: { bindingId: threadId, generation: 0 },
          reason: "parked_process_missing",
          inputId: expect.any(String),
          nativeRef: "fake-claude-session",
        },
      ]);
      expect(runtime.configDirs).toEqual([
        `/tmp/fake-claude-${threadId}`,
        `/tmp/fake-claude-${threadId}`,
        `/tmp/fake-claude-${threadId}`,
      ]);
    } finally {
      await handles.stop();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("marks a publicly visible Run failed when the selected native harness is unavailable", async () => {
    const model = await startModelEmulator({ apiKey: "test-key", steps: [] });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-native-choice-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "graphile",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "native-choice-test-encryption-key",
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `native-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Native choice",
        }),
      });
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json?: T; error?: { message?: string } };
        if (!response.ok || body.error)
          throw new Error(
            body.error?.message ??
              (body.json as { message?: string })?.message ??
              `${procedure} failed`,
          );
        return body.json as T;
      };
      const me = await rpc<{ userId: string; spaceId: string }>("me", {});
      await rpc("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: "test-key",
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Native",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      await configureNativeFixture(handles.prisma, bot.id);
      const storedBot = await handles.prisma.bot.findUniqueOrThrow({
        where: { id: bot.id },
        include: { computer: true },
      });
      expect(storedBot.computer).not.toBeNull();
      const receipt = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Return a result",
        harness: "codex-native",
        executionTarget: storedBot.computer!.id,
      });
      const completed = await handles.prisma.run.findUniqueOrThrow({
        where: { id: receipt.runId },
      });
      expect(completed).toMatchObject({
        harness: "codex-native",
        executionTarget: storedBot.computer!.id,
        choiceVersion: 1,
      });
      await handles.executor.continueRun(completed.id, "native-choice");
      const publicRun = await waitForPublicTerminalRun(handles.prisma, me, completed.id);
      expect(publicRun.status).toBe("failed");
      const legacyReceipt = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Keep the legacy runtime",
      });
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: legacyReceipt.runId } }),
      ).resolves.toMatchObject({ harness: null, executionTarget: null, choiceVersion: null });
      // Settle the legacy run first: a send while it is active would steer into it instead of starting a Claude run.
      await handles.executor.continueRun(legacyReceipt.runId, "native-choice");
      await waitForPublicTerminalRun(handles.prisma, me, legacyReceipt.runId);
      await configureNativeFixture(handles.prisma, bot.id, "anthropic");
      const claudeReceipt = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Fail the unavailable Claude runtime",
        harness: "claude-native",
        executionTarget: storedBot.computer!.id,
      });
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: claudeReceipt.runId } }),
      ).resolves.toMatchObject({
        harness: "claude-native",
        executionTarget: storedBot.computer!.id,
      });
      await handles.executor.continueRun(claudeReceipt.runId, "native-choice");
      await expect(
        waitForPublicTerminalRun(handles.prisma, me, claudeReceipt.runId),
      ).resolves.toMatchObject({ status: "failed" });
      const runsBeforeRefusal = await handles.prisma.run.count({ where: { botId: bot.id } });
      await expect(
        rpc("threads/send", {
          botId: bot.id,
          text: "Reject foreign target",
          harness: "claude-native",
          executionTarget: "missing",
        }),
      ).rejects.toThrow("Execution target is not authorized.");
      await expect(handles.prisma.run.count({ where: { botId: bot.id } })).resolves.toBe(
        runsBeforeRefusal,
      );
    } finally {
      await handles.stop();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
