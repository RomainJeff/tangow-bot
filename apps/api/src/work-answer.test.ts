import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { RunSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { InvalidAnswerError, IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { answerDelegatedWork } from "./work-answer.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

const work = {
  id: "work-1",
  spaceId: "space-1",
  userId: "user-1",
  status: "dispatched",
  specialistThreadId: "thread-specialist",
};

const delegatedRun = {
  id: "run-1",
  scopedTaskId: "work-1",
  threadId: "thread-specialist",
  trigger: "delegate",
};

type ScopedTaskWhere = {
  id?: string;
  spaceId?: string;
  userId?: string;
  status?: { notIn?: string[] };
};

type RunWhere = {
  id?: string;
  scopedTaskId?: string;
  threadId?: string;
  trigger?: { in?: string[] };
};

/** Mimics Prisma's matching for exactly the filters answerDelegatedWork submits. */
function fakePrisma(
  task: typeof work | null,
  run: typeof delegatedRun | null,
  messageBlocks: unknown = null,
) {
  return {
    scopedTask: {
      findFirst: vi.fn(async ({ where }: { where: ScopedTaskWhere }) => {
        if (!task) return null;
        if (where.id !== task.id) return null;
        if (where.spaceId !== task.spaceId) return null;
        if (where.userId !== task.userId) return null;
        if ((where.status?.notIn ?? []).includes(task.status)) return null;
        return task;
      }),
    },
    run: {
      findFirst: vi.fn(async ({ where }: { where: RunWhere }) => {
        if (!run) return null;
        if (where.id !== run.id) return null;
        if (where.scopedTaskId !== run.scopedTaskId) return null;
        if (where.threadId !== run.threadId) return null;
        if (!(where.trigger?.in ?? []).includes(run.trigger)) return null;
        return run;
      }),
    },
    message: {
      findFirst: vi.fn(async () => ({ id: "message-1", blocks: messageBlocks })),
    },
  } as unknown as PrismaClient;
}

function workDeps(
  prisma: PrismaClient,
  answerRunInput = vi.fn().mockResolvedValue(true),
  enqueue = vi.fn().mockResolvedValue(undefined),
) {
  return {
    prisma,
    events: { answerRunInput },
    jobs: { enqueue },
  } as never;
}

const input = { workId: "work-1", runId: "run-1", messageId: "message-1", answer: "allow" };

describe("answerDelegatedWork", () => {
  it("answers through the server-derived specialist thread", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const deps = workDeps(fakePrisma(work, delegatedRun), answerRunInput, enqueue);

    await expect(answerDelegatedWork(deps, actor, input)).resolves.toEqual({ ok: true });

    expect(answerRunInput).toHaveBeenCalledOnce();
    expect(answerRunInput).toHaveBeenCalledWith({
      spaceId: "space-1",
      threadId: "thread-specialist",
      runId: "run-1",
      messageId: "message-1",
      answeredByUserId: "user-1",
      answer: "allow",
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("accepts always like threads.answer", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const deps = workDeps(fakePrisma(work, delegatedRun), answerRunInput);

    await expect(answerDelegatedWork(deps, actor, { ...input, answer: "always" })).resolves.toEqual(
      { ok: true },
    );
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-specialist", answer: "always" }),
    );
  });

  it("refuses another user without answering", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const deps = workDeps(fakePrisma(work, delegatedRun), answerRunInput);

    await expect(
      answerDelegatedWork(deps, { ...actor, userId: "user-2" }, input),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("refuses another space without answering", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const deps = workDeps(fakePrisma(work, delegatedRun), answerRunInput);

    await expect(
      answerDelegatedWork(deps, { ...actor, spaceId: "space-2" }, input),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it.each(["closed", "cancelled"])("refuses a %s work without answering", async (status) => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const deps = workDeps(fakePrisma({ ...work, status }, delegatedRun), answerRunInput);

    await expect(answerDelegatedWork(deps, actor, input)).rejects.toBeInstanceOf(IsolationError);
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("refuses a run of another work without answering", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const deps = workDeps(fakePrisma(work, delegatedRun), answerRunInput);

    await expect(
      answerDelegatedWork(deps, actor, { ...input, runId: "run-other-work" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it.each(["user", "follow_up", "bot_message"])(
    "refuses a %s run as not delegated",
    async (trigger) => {
      const answerRunInput = vi.fn().mockResolvedValue(true);
      const deps = workDeps(fakePrisma(work, { ...delegatedRun, trigger }), answerRunInput);

      await expect(answerDelegatedWork(deps, actor, input)).rejects.toBeInstanceOf(IsolationError);
      expect(answerRunInput).not.toHaveBeenCalled();
    },
  );

  it("refuses a delegated secret request without answering", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const deps = workDeps(
      fakePrisma(work, delegatedRun, [
        {
          kind: "ask",
          text: "Provide the API key",
          input: "secret",
          status: "pending",
        },
      ]),
      answerRunInput,
    );

    await expect(answerDelegatedWork(deps, actor, input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(answerRunInput).not.toHaveBeenCalled();
  });

  it("maps a malformed answer to BAD_REQUEST", async () => {
    const answerRunInput = vi
      .fn()
      .mockRejectedValue(new InvalidAnswerError("Question 1 needs an answer"));
    const deps = workDeps(fakePrisma(work, delegatedRun), answerRunInput);

    await expect(answerDelegatedWork(deps, actor, input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(answerRunInput).toHaveBeenCalledOnce();
  });

  it("reports a settled prompt as CONFLICT", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(false);
    const deps = workDeps(fakePrisma(work, delegatedRun), answerRunInput);

    await expect(answerDelegatedWork(deps, actor, input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("delegated run contracts", () => {
  it("parses a specialist run's delegate trigger", () => {
    const base = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "waiting_input",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date("2026-09-24T00:00:00.000Z").toISOString(),
    };
    expect(RunSchema.parse({ ...base, trigger: "delegate" }).trigger).toBe("delegate");
    expect(RunSchema.parse({ ...base, trigger: "delegate_followup" }).trigger).toBe(
      "delegate_followup",
    );
  });

  it("keeps threads.answer on the coordinator thread, off the specialist run", async () => {
    // The real answerRunInput filters the run by threadId. The specialist run lives on the
    // work thread, and threads.answer can only ever name the coordinator's own thread, so
    // from that thread the specialist run is unreachable: the mock mirrors that filter.
    const specialistThreadId = "thread-specialist";
    const coordinatorThreadId = "thread-coordinator";
    const answerRunInput = vi
      .fn()
      .mockImplementation(
        async (args: { threadId: string }) => args.threadId === specialistThreadId,
      );
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-coordinator",
          thread: { id: coordinatorThreadId },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-work-answer-test",
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            botId: "bot-coordinator",
            runId: "run-specialist",
            messageId: "message-specialist-ask",
            answer: "allow",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(409);
    expect(answerRunInput).toHaveBeenCalledOnce();
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: coordinatorThreadId }),
    );
    expect(answerRunInput.mock.calls[0]![0]!.threadId).not.toBe(specialistThreadId);
  });
});
