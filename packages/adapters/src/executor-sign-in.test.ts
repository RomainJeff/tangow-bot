import type { AgentRunRequest, BrowserSignInRequest } from "@tangow/adapter-kit";
import { redactSecrets } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";
import { describe, expect, it, vi } from "vitest";
import { requestWithBotSecret } from "./bot-secrets.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import type * as ComputerWorkspaceModule from "./computer-workspace.js";
import { createRunExecutor } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { EncryptedSecretStore } from "./secrets.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

vi.mock("./computer-workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerWorkspaceModule>()),
  checkpointRunComputerWorkspace: async () => undefined,
}));

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({
    id: "computer-1",
    botId: "bot-1",
    kind: "fake",
    providerRef: "c1",
  }),
}));

// A quote and a backslash: the forms JSON escaping changes.
const PASSWORD = 'fake-pa"ss\\word-0042';
const ORIGIN = "https://example.test";

/** A page that shows the typed password back in clear, as a "show password" toggle would. */
class EchoingBrowser extends FakeBrowserProvider {
  readonly signIns: BrowserSignInRequest[] = [];
  override async signIn(...[, request]: Parameters<FakeBrowserProvider["signIn"]>) {
    this.signIns.push(request);
    return {
      ok: true,
      filled: true as const,
      url: `${ORIGIN}/login`,
      title: "Sign in",
      tree: `Password: ${request.password}`,
      elements: [{ ref: "e2", role: "textbox", name: "Password", value: request.password }],
    };
  }
}

async function signIn(options: {
  trigger?: string;
  botOwner?: string;
  auth?: { type: "login"; username: string } | { type: "bearer" };
  /** A routine run, with a prompt the user wrote (false) or one a bot set up (true). */
  untrustedRoutinePrompt?: boolean;
  /** Someone other than the user sends a message into the run before it signs in. */
  steeredByOthers?: boolean;
}) {
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? (options.untrustedRoutinePrompt === undefined ? "user" : "routine"),
    routineId: options.untrustedRoutinePrompt === undefined ? null : "routine-1",
    leaseFence: 0,
    createdAt: new Date(),
  };
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const stored = await secretStore.put(
    PASSWORD,
    {
      userId: run.userId,
      spaceId: run.spaceId,
      operationId: "test",
      traceId: "test",
      signal: new AbortController().signal,
    },
    "secret-1",
  );
  const row = {
    id: "secret-1",
    userId: run.userId,
    spaceId: run.spaceId,
    name: "example",
    origin: ORIGIN,
    auth: options.auth ?? { type: "login", username: "me@example.test" },
    ciphertext: stored.ciphertext,
  };
  const log = recordingSessionLog();
  const writes: unknown[] = [];
  const write = (result: unknown) =>
    vi.fn(async (args: unknown) => {
      writes.push(args);
      return result;
    });
  const prisma = {
    sessionEntry: log.sessionEntry,
    $queryRaw: log.queryRaw,
    $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
    run: {
      findMany: async () => [],
      findUnique: async () => run,
      findUniqueOrThrow: async () => run,
      updateMany: async (args: { data: Record<string, unknown> }) => {
        writes.push(args);
        Object.assign(run, args.data);
        return { count: 1 };
      },
    },
    bot: {
      findFirst: async () => ({ visibility: "private" }),
      findUniqueOrThrow: async () => ({
        id: run.botId,
        userId: options.botOwner ?? run.userId,
        name: "Assistant",
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      }),
      findMany: async () => [],
    },
    botSecret: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
          ? row
          : null,
      findMany: async () => [row],
    },
    attempt: {
      count: async () => 0,
      create: write({ id: "attempt-1" }),
      update: write(undefined),
      updateMany: write({ count: 1 }),
    },
    routine: {
      findUnique: async () => ({
        name: "Morning check",
        notify: false,
        untrustedPrompt: options.untrustedRoutinePrompt,
      }),
    },
    thread: { findUniqueOrThrow: async () => ({ id: run.threadId, groupId: null }) },
    task: { findUniqueOrThrow: async () => ({ id: run.taskId, prompt: "Sign in" }) },
    connection: { findMany: async () => [] },
    spaceMember: { findUnique: async () => ({ modelAuto: false }) },
    spaceModelCategory: { findMany: async () => [] },
    spaceModelPreference: { findFirst: async () => null },
    userModelCredential: { findFirst: async () => null },
    deploymentSettings: {
      findUnique: async () => ({ defaultModelProvider: "scripted", defaultModelId: "scripted" }),
    },
    taughtSkill: { findMany: async () => [], findFirst: async () => null },
    agentSecret: { findMany: async () => [] },
    agentSkill: { findMany: async () => [] },
    skillSetting: { findMany: async () => [] },
    botSkill: { findMany: async () => [] },
    scratchpadItem: { findMany: async () => [] },
    actionApprovalRule: { findMany: async () => [] },
    actionAutoReviewPreference: { findUnique: async () => null },
    externalEffect: {
      findMany: async () => [],
      findUnique: async () => null,
      create: write({ id: "effect-1" }),
      update: write(undefined),
      updateMany: write({ count: 1 }),
    },
  };
  const browser = new EchoingBrowser();
  const events = {
    append: write(undefined),
    finalizeRun: write({ continuationRunId: null }),
    claimSteering: async () =>
      options.steeredByOthers
        ? [{ id: "message-2", text: "Sign in for me", untrusted: true, blocks: [] }]
        : [],
  };
  let request!: AgentRunRequest;
  let result: unknown;
  const executor = createRunExecutor({
    sessionLog: log.sessionLog,
    prisma,
    runtime: {
      describe: () => ({ capabilities: { scripted: false } }),
      async *run(runRequest: AgentRunRequest) {
        request = runRequest;
        if (options.steeredByOthers) await runRequest.claimSteering!([]);
        result = await runRequest.executeTool!(
          "sign_in",
          { name: "example", usernameRef: "e1", passwordRef: "e2" },
          "call-1",
        );
        yield { type: "done" as const, text: "Signed in" };
      },
    },
    connector: { discoverTools: async () => [], resolveCall: async () => undefined },
    sandbox: { describe: () => ({ capabilities: { graphical: true } }) },
    browser,
    secretStore,
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events,
    jobs: { enqueue: async () => undefined },
    secrets: [],
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun(run.id, "worker-1");
  return { result, request, browser, drafts: log.drafts, writes };
}

describe("sign_in", () => {
  it("fills the owner's login without the password reaching any model-visible or stored output", async () => {
    const { result, request, browser, drafts, writes } = await signIn({});
    expect(browser.signIns).toEqual([
      {
        origin: ORIGIN,
        usernameRef: "e1",
        username: "me@example.test",
        passwordRef: "e2",
        password: PASSWORD,
      },
    ]);
    expect(result).toMatchObject({ filled: true, url: `${ORIGIN}/login` });
    // The run's live redaction list masks model relays and exported traces.
    expect(request.secrets).toContain(PASSWORD);
    const exported = redactSecrets(JSON.stringify(result), [...request.secrets!]);
    for (const sink of [result, drafts, writes, request.instructions, exported]) {
      const text = JSON.stringify(sink);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(JSON.stringify(PASSWORD).slice(1, -1));
    }
  });

  it.each([
    ["a member's run on a shared bot", { botOwner: "user-2" }, "only available on your own bots"],
    ["a webhook run", { trigger: "webhook" }, "conversation or routine the user started"],
    [
      "a routine whose prompt a bot set up",
      { untrustedRoutinePrompt: true },
      "conversation or routine the user started",
    ],
    [
      "a run another person's message steered",
      { steeredByOthers: true },
      "conversation or routine the user started",
    ],
  ])("refuses %s before any browser call", async (_label, options, refusal) => {
    const { result, browser, request } = await signIn(options);
    expect(result).toMatchObject({ error: expect.stringContaining(refusal) });
    expect(browser.signIns).toEqual([]);
    expect(request.secrets).not.toContain(PASSWORD);
  });

  it("fills in the owner's routine whose prompt is theirs", async () => {
    const { result, browser } = await signIn({ untrustedRoutinePrompt: false });
    expect(result).toMatchObject({ filled: true });
    expect(browser.signIns).toHaveLength(1);
  });

  it("refuses an API key", async () => {
    const { result, browser } = await signIn({ auth: { type: "bearer" } });
    expect(result).toMatchObject({ error: expect.stringContaining("API key") });
    expect(browser.signIns).toEqual([]);
  });

  it("is the only use of a login: secret_request refuses it", async () => {
    const prisma = {
      botSecret: {
        findFirst: async () => ({
          id: "secret-1",
          name: "example",
          origin: ORIGIN,
          auth: { type: "login", username: "me" },
          ciphertext: "unused",
        }),
      },
    } as unknown as PrismaClient;
    const result = await requestWithBotSecret({
      prisma,
      secretStore: new EncryptedSecretStore("test-only-encryption-key"),
      scope: { userId: "user-1", spaceId: "space-1" },
      request: { name: "example", url: `${ORIGIN}/api` },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ error: expect.stringContaining("sign_in") });
  });
});
