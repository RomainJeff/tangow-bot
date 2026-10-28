import type { AgentRunRequest, AgentRuntimeEvent, ArtifactPut } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import type { FakeWebProvider } from "./fake-web.js";
import { recordingSessionLog } from "./session-log/recording.test-support.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  holdComputerExecutionLeaseForTakeover: async () => true,
  provisionComputer: async () => ({ id: "computer-1", kind: "docker" }),
}));

/**
 * When a bot run ends, the executor queues one `link.preview` job for it. This harness is modelled
 * on executor-effect-idempotency.test.ts (the approval and effect lookups every `applyTool` call
 * walks through).
 */
type StoredEffect = {
  id: string;
  runId?: string;
  kind: string;
  idempotencyKey: string;
  status: string;
  request: unknown;
  result?: unknown;
  reviewDecision?: string;
};

function fixture({
  trigger = "user",
  parentBotId = null as string | null,
  routineId = null as string | null,
  routineNotify = false,
  notifyOnFinish = true,
  crons = ["0 9 * * *"],
  clientNonce = null as string | null,
  groupId = null as string | null,
  requireToolApproval = true,
  chattyReplies = false,
  secrets = [] as string[],
  checkpoint = null as string | null,
  status = "queued",
  steering = [] as Array<{ id: string; messageId: string; text: string; blocks: MessageBlock[] }>,
  web,
  runtimeRun,
}: {
  trigger?: string;
  parentBotId?: string | null;
  routineId?: string | null;
  routineNotify?: boolean;
  notifyOnFinish?: boolean;
  crons?: string[];
  clientNonce?: string | null;
  groupId?: string | null;
  requireToolApproval?: boolean;
  chattyReplies?: boolean;
  secrets?: string[];
  checkpoint?: string | null;
  status?: string;
  /** User messages waiting to be steered into the run: handed out by the first claim. */
  steering?: Array<{ id: string; messageId: string; text: string; blocks: MessageBlock[] }>;
  web?: FakeWebProvider;
  runtimeRun: (request: AgentRunRequest) => AsyncGenerator<AgentRuntimeEvent>;
}) {
  const run = {
    id: "run-1",
    sessionId: "session-main",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status,
    trigger,
    routineId,
    clientNonce,
    requireToolApproval,
    leaseFence: 0,
    checkpoint,
    createdAt: new Date("2026-10-16T07:00:00.000Z"),
  };

  const finalizeRun = vi.fn(
    async ({
      outcome,
    }: {
      outcome: "completed" | "failed";
      blocks?: MessageBlock[];
      markUnread?: boolean;
    }) => {
      run.status = outcome;
      return { continuationRunId: null };
    },
  );

  const pauseRunForInput = vi.fn(async () => {
    run.status = "waiting_input";
    return true;
  });

  const pauseRunForTakeover = vi.fn(async (_input: { reason: string }) => {
    run.status = "waiting_takeover";
    return true;
  });

  const effects: StoredEffect[] = [];
  const externalEffect = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: string; runId?: string; status?: string; kind?: string };
      } = {}) =>
        effects.filter((effect) => {
          if (where?.status && effect.status !== where.status) return false;
          if (where?.kind && effect.kind !== where.kind) return false;
          if (where?.runId && effect.runId && effect.runId !== where.runId) return false;
          if (where?.id && effect.id !== where.id) return false;
          return true;
        }),
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        effects.find((effect) =>
          where.id ? effect.id === where.id : effect.idempotencyKey === where.idempotencyKey,
        ) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: Omit<StoredEffect, "id"> }) => {
      const effect = { ...data, id: `effect-${effects.length + 1}` };
      effects.push(effect);
      return { ...effect };
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Partial<StoredEffect> }) => {
        Object.assign(effects.find((effect) => effect.id === where.id)!, data);
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Partial<StoredEffect>;
      }) => {
        const effect = effects.find(
          (effect) => effect.id === where.id && effect.status === where.status,
        );
        if (!effect) return { count: 0 };
        Object.assign(effect, data);
        return { count: 1 };
      },
    ),
  };

  const log = recordingSessionLog();

  const widgetArtifacts: Array<{ id: string; [key: string]: unknown }> = [];
  const widgetBytes = new Map<string, Uint8Array>();
  const readFile = vi.fn(async (_computer: unknown, file: string) => {
    if (!file.endsWith("view.html")) throw new Error("file not found");
    return new TextEncoder().encode("<p>From the computer</p>");
  });
  const prisma = {
    artifact: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `artifact-${widgetArtifacts.length + 1}` };
        widgetArtifacts.push(row);
        return row;
      }),
    },
    sessionEntry: log.sessionEntry,
    $queryRaw: log.queryRaw,
    run: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish },
        thread: { groupId },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        parentBotId,
        chattyReplies,
        computerId: "computer-1",
        computer: { id: "computer-1", scope: "dedicated" },
      })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    user: { findUnique: vi.fn(async () => null) },
    routine: {
      findUnique: vi.fn(async () =>
        routineId ? { id: routineId, name: "Routine", notify: routineNotify, crons } : null,
      ),
    },
    attempt: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: "attempt-1" })),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      // The thread row as the run's opening reads and a message it publishes see it.
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId,
        sessionId: "session-main",
        botId: run.botId,
        nextEventSeq: 1,
      })),
      update: vi.fn(async () => ({ sessionId: "session-main", botId: run.botId })),
      findFirst: vi.fn(async () => ({ groupId })),
      count: vi.fn(async () => 0),
    },
    chatGroup: {
      findUnique: vi.fn(async () => ({
        id: groupId,
        name: "Crew",
        description: "",
        members: [],
      })),
    },
    chatGroupMember: { findMany: vi.fn(async () => []) },
    event: { create: vi.fn(async () => ({ id: "event-1" })) },
    task: { findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Help the user" })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "scripted",
        defaultModelId: "scripted",
      })),
    },
    taughtSkill: { findMany: vi.fn(async () => []) },
    agentSecret: { findMany: vi.fn(async () => []) },
    agentSkill: { findMany: vi.fn(async () => []) },
    skillSetting: { findMany: vi.fn(async () => []) },
    botSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    actionAutoReviewPreference: { findUnique: vi.fn(async () => ({ enabled: false })) },
    externalEffect,
  };
  (prisma as unknown as { $transaction: unknown }).$transaction = vi.fn(
    async (fn: (tx: typeof prisma) => unknown) => fn(prisma),
  );

  const append = vi.fn(async (_event: { type: string }) => undefined);
  const notify = vi.fn(async () => undefined);
  const send = vi.fn(
    async (_message: { kind: string; title: string; subtitle?: string; body: string }) => undefined,
  );
  const enqueue = vi.fn(async (_job?: { name: string }) => undefined);
  const executor = createRunExecutor({
    sessionLog: log.sessionLog,
    prisma,
    runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
    sandbox: { describe: () => ({ capabilities: { graphical: false } }), readFile },
    artifacts: {
      put: async ({ bytes }: ArtifactPut) => {
        const id = `stored-${widgetBytes.size + 1}`;
        widgetBytes.set(id, bytes);
        return { id, hash: "hash" };
      },
      remove: async (id: string) => {
        widgetBytes.delete(id);
      },
    },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append,
      claimSteering: vi.fn(async () => steering.splice(0)),
      finalizeRun,
      notify,
      pauseRunForInput,
      pauseRunForTakeover,
    },
    jobs: { enqueue },
    notifications: { send },
    secrets,
    web,
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  return {
    widgetArtifacts,
    widgetBytes,
    readFile,
    runRow: run,
    enqueue,
    /** Events appended to the thread (progress, tool calls, ...). */
    appended: append,
    /** Entries the run wrote to the log, in order. */
    drafts: log.drafts,
    /** Push notifications sent to the user. */
    pushes: send,
    finalizeRun,
    pauseRunForInput,
    pauseRunForTakeover,
    async run() {
      await executor.continueRun(run.id, "worker-1");
    },
  };
}

describe("link previews of a run (CA 13, CA 14, CA 70, CA 72)", () => {
  const previewJobs = (f: ReturnType<typeof fixture>) =>
    (f.enqueue.mock.calls as unknown as Array<[{ name: string; payload: unknown }]>)
      .map(([job]) => job)
      .filter((job) => job.name === "link.preview");

  it("queues one link.preview job, by run id, after a completed run", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: "Done: https://example.test/a" };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(previewJobs(f)).toEqual([
      expect.objectContaining({
        name: "link.preview",
        payload: { runId: "run-1" },
        maxAttempts: 1,
      }),
    ]);
    // After the commit: finalizeRun has already returned.
    expect(f.finalizeRun.mock.invocationCallOrder[0]!).toBeLessThan(
      f.enqueue.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("shows only message_user, never the text around tools or the final reply", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun(request) {
        yield { type: "text", text: "Let me check the logs first. " };
        yield { type: "tool", name: "message_user", args: {}, executionId: "call-1" };
        await request.executeTool!("message_user", { message: "Found it." }, "call-1");
        yield { type: "text", text: "Now writing the summary. " };
        yield { type: "tool", name: "web_search", args: {}, executionId: "call-2" };
        yield { type: "text", text: "All fixed." };
        yield {
          type: "done",
          text: "Let me check the logs first. Now writing the summary. All fixed.",
        };
      },
    });

    await f.run();

    const finalBlocks = f.finalizeRun.mock.calls.at(-1)![0].blocks ?? [];
    const logged = f.drafts.flatMap(
      (draft) => (draft.payload as { blocks?: MessageBlock[] }).blocks ?? [],
    );
    const shown = [...logged, ...finalBlocks]
      .flatMap((block) => (block.kind === "text" ? [block.text] : []))
      .join("|");
    expect(shown).toBe("Found it.");
    const streamed = (f.appended.mock.calls as unknown as Array<[{ type: string }]>).filter(
      ([event]) => event.type === "thread.progress",
    );
    expect(streamed).toEqual([]);
  });

  it("pushes the last message_user's words without its markdown", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun(request) {
        yield { type: "tool", name: "message_user", args: {}, executionId: "call-1" };
        await request.executeTool!(
          "message_user",
          { message: "**Done**: see [the report](https://example.test/a)" },
          "call-1",
        );
        yield { type: "text", text: "Private closing note." };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(f.pushes.mock.calls.map(([message]) => message.body)).toEqual(["Done: see the report"]);
  });

  it("pushes nothing for a finished reply with no words, but still pushes its failure", async () => {
    const image = "![](https://example.test/a.png)";
    const finished = fixture({
      trigger: "user",
      async *runtimeRun(request) {
        yield { type: "tool", name: "message_user", args: {}, executionId: "call-1" };
        await request.executeTool!("message_user", { message: image }, "call-1");
        yield { type: "done" };
      },
    });
    const failed = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: image };
        throw new Error("model exploded");
      },
    });

    await finished.run();
    await failed.run();

    expect(finished.pushes.mock.calls.map(([message]) => message.body)).toEqual([]);
    expect(failed.pushes.mock.calls.map(([message]) => message.body)).toEqual(["model exploded"]);
  });

  it("queues nothing for a bot-to-bot run", async () => {
    const f = fixture({
      trigger: "bot_message",
      async *runtimeRun() {
        yield { type: "text", text: "Done: https://example.test/a" };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(previewJobs(f)).toEqual([]);
  });

  it("queues one job for a routine card run: its result is a bubble the person reads", async () => {
    const f = fixture({
      trigger: "routine",
      routineId: "routine-1",
      parentBotId: "bot-0",
      async *runtimeRun() {
        yield { type: "text", text: "Done: https://example.test/a" };
        yield { type: "done" };
      },
    });

    await f.run();

    expect(previewJobs(f)).toEqual([
      expect.objectContaining({ name: "link.preview", payload: { runId: "run-1" } }),
    ]);
  });

  it("queues nothing for a run that failed", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun() {
        yield { type: "text", text: "Done: https://example.test/a" };
        throw new Error("model exploded");
      },
    });

    await f.run();

    expect(f.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(previewJobs(f)).toEqual([]);
  });

  it("keeps no URL or hash in the audit event of a finished tool call (CA 72)", async () => {
    const f = fixture({
      trigger: "user",
      async *runtimeRun(request) {
        const page = {
          content: [{ type: "text", text: "see https://b.test/y" }],
          details: { url: "https://final.test/z", results: [{ url: "https://hit.test/a" }] },
        };
        for (const name of ["web_fetch", "web_search", "browser_navigate"]) {
          await request.onToolCompleted?.({
            name,
            executionId: name,
            durationMs: 3,
            result: page,
          });
        }
        yield { type: "text", text: "Done: https://example.test/a" };
        yield { type: "done" };
      },
    });

    await f.run();

    const payloads = (
      f.appended.mock.calls as unknown as Array<[{ type: string; payload: unknown }]>
    )
      .map(([event]) => event)
      .filter((event) => event.type === "agent.tool.completed")
      .map((event) => event.payload);
    expect(payloads).toHaveLength(3);
    expect(JSON.stringify(payloads)).not.toMatch(/https?:|openedUrl|seenUrlHashes|[0-9a-f]{64}/);
  });
});

describe("what a routine run pushes (CA11, CA11b)", () => {
  const speaks = async function* () {
    yield { type: "text" as const, text: "Two new emails." };
    yield { type: "done" as const };
  };
  const staysSilent = async function* () {
    yield { type: "tool" as const, name: "web_search", args: {}, executionId: "call-1" };
    yield { type: "done" as const };
  };
  const fails = async function* (): AsyncGenerator<AgentRuntimeEvent> {
    yield* [];
    throw new Error("model exploded");
  };
  const pushes = async (
    options: { parentBotId?: string; routineNotify: boolean; notifyOnFinish: boolean },
    runtimeRun: () => AsyncGenerator<AgentRuntimeEvent>,
  ) => {
    const f = fixture({ trigger: "routine", routineId: "routine-1", ...options, runtimeRun });
    await f.run();
    return f.pushes.mock.calls.map(([message]) => message);
  };

  it("titles a run that speaks with its bot, under the routine's name", async () => {
    expect(await pushes({ routineNotify: false, notifyOnFinish: true }, speaks)).toEqual([
      expect.objectContaining({ title: "Assistant", subtitle: "Routine", body: "Two new emails." }),
    ]);
  });

  it.each([
    ["a bot's own routine", {}],
    ["a sub-bot's routine", { parentBotId: "bot-0" }],
  ])(
    "with Notify me on, %s pages what it says and its failures past the bot's setting",
    async (_name, bot) => {
      const options = { ...bot, routineNotify: true, notifyOnFinish: false };
      expect(await pushes(options, speaks)).toEqual([
        expect.objectContaining({ kind: "completion", body: "Two new emails." }),
      ]);
      expect(await pushes(options, staysSilent)).toEqual([]);
      expect(await pushes(options, fails)).toEqual([expect.objectContaining({ kind: "failure" })]);
    },
  );

  it("with Notify me off, follows the bot's setting", async () => {
    const options = { routineNotify: false, notifyOnFinish: false };
    expect(await pushes(options, speaks)).toEqual([]);
    expect(await pushes(options, fails)).toEqual([]);
  });
});

describe("show_widget", () => {
  it.each([null, "group-1"])(
    "stores inline and computer HTML with the thread ownership (%s)",
    async (groupId) => {
      const results: unknown[] = [];
      const f = fixture({
        groupId,
        requireToolApproval: false,
        async *runtimeRun(request) {
          for (const [index, input] of [
            { title: "Inline view", html: "<p>Inline café</p>" },
            { title: "Computer view", path: "view.html" },
          ].entries()) {
            const executionId = `widget-${index}`;
            yield { type: "tool", name: "show_widget", args: input, executionId };
            results.push(await request.executeTool!("show_widget", input, executionId));
          }
          yield { type: "done" };
        },
      });
      await f.run();
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(f.widgetArtifacts).toEqual([
        expect.objectContaining({
          id: "artifact-1",
          name: "inline-view.html",
          mimeType: "text/html",
          isWidget: true,
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          groupId: groupId ?? undefined,
          size: 19,
        }),
        expect.objectContaining({
          id: "artifact-2",
          name: "computer-view.html",
          mimeType: "text/html",
          isWidget: true,
          groupId: groupId ?? undefined,
        }),
      ]);
      expect([...f.widgetBytes.values()].map((bytes) => new TextDecoder().decode(bytes))).toEqual([
        "<p>Inline café</p>",
        "<p>From the computer</p>",
      ]);
      expect(
        f.drafts.filter((draft) => draft.type === "assistant.text").map((draft) => draft.payload),
      ).toEqual([
        {
          blocks: [{ kind: "widget", title: "Inline view", artifactId: "artifact-1" }],
          toPerson: true,
        },
        {
          blocks: [{ kind: "widget", title: "Computer view", artifactId: "artifact-2" }],
          toPerson: true,
        },
      ]);
    },
  );

  it("refuses malformed, unreadable and oversized input without publishing or storing it", async () => {
    const results: unknown[] = [];
    const f = fixture({
      requireToolApproval: false,
      async *runtimeRun(request) {
        for (const [index, input] of [
          { html: "<p>No title</p>" },
          { title: " ", html: "<p>Empty title</p>" },
          { title: "Both", html: "", path: "view.html" },
          { title: "Neither" },
          { title: "Too big", html: "é".repeat(1024 * 1024 + 1) },
          { title: "Missing", path: "missing.html" },
          ...["100vh", "10dvh", "3.5svh", ".5lvh"].map((unit) => ({
            title: "Viewport",
            html: `<div style="height: ${unit}"></div>`,
          })),
        ].entries()) {
          const executionId = `widget-${index}`;
          yield { type: "tool", name: "show_widget", args: input, executionId };
          results.push(await request.executeTool!("show_widget", input, executionId));
        }
        yield { type: "done" };
      },
    });
    await f.run();
    expect(results).toEqual([
      { error: "title is required" },
      { error: "title is required" },
      { error: "Provide exactly one of html or path" },
      { error: "Provide exactly one of html or path" },
      { error: "Widget exceeds the 2 MiB limit" },
      { error: "file not found" },
      ...Array.from({ length: 4 }, () => ({
        error: "Viewport height units are not supported. Use fixed pixel heights instead.",
      })),
    ]);
    expect(f.widgetArtifacts).toEqual([]);
    expect(f.widgetBytes.size).toBe(0);
    expect(f.drafts.filter((draft) => draft.type === "assistant.text")).toEqual([]);
  });
});
