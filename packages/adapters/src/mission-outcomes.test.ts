import { describe, expect, it, vi } from "vitest";
import { publishDelegatedMissionOutcome } from "./executor.js";

type Receipt = {
  id: string;
  seq: number;
  replyToMessageId: string;
  runId: string;
};

function harness(input: {
  sourceId: string;
  receipts: Receipt[];
  requests: Array<{ id: string; runId: string }>;
  roots: Record<string, { trigger: string; sourceMessageId: string | null }>;
}) {
  const created: string[] = [];
  const receipt = (id: string) => {
    const item = input.receipts.find((candidate) => candidate.id === id);
    if (!item) return null;
    return {
      id: item.id,
      seq: item.seq,
      replyToMessageId: item.replyToMessageId,
      blocks: [
        {
          kind: "bot_message_received",
          fromBotId: "child",
          fromBotName: "Child",
          fromRunId: item.runId,
          text: item.id,
          intent: "result",
        },
      ],
      replyTo: {
        runId: input.requests.find((request) => request.id === item.replyToMessageId)?.runId,
        botId: "parent",
        threadId: "thread",
      },
    };
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    message: {
      findUnique: vi.fn((args: { where: { id?: string; threadId_clientNonce?: unknown } }) => {
        if (args.where.threadId_clientNonce) return Promise.resolve(null);
        const found = receipt(args.where.id ?? "");
        if (found) return Promise.resolve(found);
        const runId = Object.entries(input.roots).find(
          ([, value]) => value.sourceMessageId === args.where.id,
        )?.[0];
        return Promise.resolve(
          runId
            ? {
                replyTo: {
                  runId:
                    input.roots[runId]!.sourceMessageId === "root-receipt" ? "root" : undefined,
                },
              }
            : null,
        );
      }),
      findMany: vi.fn((args: { where: { replyToMessageId?: { in: string[] } } }) => {
        if (args.where.replyToMessageId) {
          return Promise.resolve(
            input.receipts
              .filter((item) => args.where.replyToMessageId!.in.includes(item.replyToMessageId))
              .map((item) => receipt(item.id)),
          );
        }
        return Promise.resolve(
          input.requests.map((request) => ({
            ...request,
            blocks: [
              {
                kind: "bot_message_sent",
                toBotId: "child",
                toBotName: "Child",
                text: request.id,
                intent: "request",
              },
            ],
          })),
        );
      }),
      create: vi.fn(async (args: { data: { clientNonce: string } }) => {
        created.push(args.data.clientNonce);
        return { id: `published-${created.length}` };
      }),
    },
    run: {
      findUnique: vi.fn((args: { where: { id: string } }) => {
        const value = input.roots[args.where.id];
        if (!value) return Promise.resolve({ status: "completed" });
        return Promise.resolve({ id: args.where.id, ...value, createdAt: new Date(0) });
      }),
      findMany: vi.fn(async () =>
        input.receipts.map((item) => ({ id: item.runId, status: "completed" })),
      ),
    },
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    event: { create: vi.fn().mockResolvedValue({ seq: 1 }) },
  };
  return {
    created,
    deps: {
      prisma: { $transaction: vi.fn((operation: (client: typeof tx) => unknown) => operation(tx)) },
      events: { notify: vi.fn().mockResolvedValue(undefined) },
    } as any,
  };
}

function run(sourceMessageId: string) {
  return {
    id: `wake-${sourceMessageId}`,
    spaceId: "space",
    threadId: "thread",
    botId: "parent",
    sourceMessageId,
  };
}

describe("mission outcomes", () => {
  it("waits for a pending contribution, then lets its new receipt consolidate", async () => {
    const state = harness({
      sourceId: "root-receipt",
      receipts: [
        { id: "root-receipt", seq: 1, replyToMessageId: "root-request", runId: "child-root" },
      ],
      requests: [
        { id: "root-request", runId: "root" },
        { id: "nested-request", runId: "nested" },
      ],
      roots: {
        root: { trigger: "user", sourceMessageId: null },
        nested: { trigger: "bot_message", sourceMessageId: "root-receipt" },
      },
    });
    await expect(
      publishDelegatedMissionOutcome(state.deps, run("root-receipt"), "partial"),
    ).resolves.toMatchObject({ ok: false });

    const completed = harness({
      sourceId: "nested-receipt",
      receipts: [
        { id: "root-receipt", seq: 1, replyToMessageId: "root-request", runId: "child-root" },
        { id: "nested-receipt", seq: 2, replyToMessageId: "nested-request", runId: "child-nested" },
      ],
      requests: [
        { id: "root-request", runId: "root" },
        { id: "nested-request", runId: "nested" },
      ],
      roots: {
        root: { trigger: "user", sourceMessageId: null },
        nested: { trigger: "bot_message", sourceMessageId: "root-receipt" },
      },
    });
    await expect(
      publishDelegatedMissionOutcome(completed.deps, run("nested-receipt"), "combined"),
    ).resolves.toMatchObject({ ok: true });
    expect(completed.created).toHaveLength(1);
  });

  it("treats a nested redélégation after a first outcome as a new receipt version", async () => {
    const first = harness({
      sourceId: "first-receipt",
      receipts: [
        { id: "first-receipt", seq: 1, replyToMessageId: "first-request", runId: "child-first" },
      ],
      requests: [{ id: "first-request", runId: "root" }],
      roots: { root: { trigger: "user", sourceMessageId: null } },
    });
    await expect(
      publishDelegatedMissionOutcome(first.deps, run("first-receipt"), "first"),
    ).resolves.toMatchObject({ ok: true });

    const revision = harness({
      sourceId: "revision-receipt",
      receipts: [
        { id: "first-receipt", seq: 1, replyToMessageId: "first-request", runId: "child-first" },
        {
          id: "revision-receipt",
          seq: 2,
          replyToMessageId: "revision-request",
          runId: "child-revision",
        },
      ],
      requests: [
        { id: "first-request", runId: "root" },
        { id: "revision-request", runId: "nested" },
      ],
      roots: {
        root: { trigger: "user", sourceMessageId: null },
        nested: { trigger: "bot_message", sourceMessageId: "first-receipt" },
      },
    });
    await expect(
      publishDelegatedMissionOutcome(revision.deps, run("revision-receipt"), "revision"),
    ).resolves.toMatchObject({ ok: true });
    expect(revision.created).toHaveLength(1);
  });

  it("keeps independent roots separate in one bot thread", async () => {
    const state = harness({
      sourceId: "a-receipt",
      receipts: [
        { id: "a-receipt", seq: 1, replyToMessageId: "a-request", runId: "child-a" },
        { id: "b-receipt", seq: 2, replyToMessageId: "b-request", runId: "child-b" },
      ],
      requests: [
        { id: "a-request", runId: "root-a" },
        { id: "b-request", runId: "root-b" },
      ],
      roots: {
        "root-a": { trigger: "user", sourceMessageId: null },
        "root-b": { trigger: "user", sourceMessageId: null },
      },
    });
    await expect(
      publishDelegatedMissionOutcome(state.deps, run("a-receipt"), "a"),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      publishDelegatedMissionOutcome(state.deps, run("b-receipt"), "b"),
    ).resolves.toMatchObject({ ok: true });
    expect(state.created).toHaveLength(2);
  });
});
