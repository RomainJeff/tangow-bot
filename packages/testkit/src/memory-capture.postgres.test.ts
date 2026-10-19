import { createHash } from "node:crypto";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  SessionEntryDraft,
} from "@rakazo/adapter-kit";
import { PostgresSessionLog } from "@rakazo/adapters";
import type { SessionId } from "@rakazo/contracts";
import { MarkdownMemoryLibrary, MarkdownMemoryStore } from "@rakazo/memory";
import { describe, expect, it } from "vitest";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import { memoryDatabaseAvailable, useMemoryApp } from "./memory-app.js";

describe.skipIf(!memoryDatabaseAvailable)("durable memory capture (PostgreSQL)", () => {
  const app = useMemoryApp("memory-capture", () => import("../../../apps/api/src/app.ts"), {
    encryptionKey: "offline-memory-capture-fixture-key",
  });
  const { rpc, signup } = app;

  async function createCaptureThread() {
    const member = await signup("Capture Fixture");
    const bot = await rpc<{ id: string }>(member, "bots/create", {
      name: "Capture Fixture Bot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await app.handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const sessionId = thread.sessionId as SessionId;
    const sourceText = "Please call me Rom.";
    const [source] = await append(
      sessionId,
      Array.from({ length: 50 }, (_, seq) => ({
        type: "user.message",
        payload: {
          blocks: [{ kind: "text", text: seq === 0 ? sourceText : `Fixture message ${seq}.` }],
          source: "app",
        },
      })),
      bot.id,
    );
    return {
      member,
      botId: bot.id,
      threadId: thread.id,
      sessionId,
      sourceId: source!.id,
      sourceText,
    };
  }

  async function append(
    sessionId: SessionId,
    drafts: Array<Pick<SessionEntryDraft, "type" | "payload">>,
    feedBotId: string,
  ) {
    const log = new PostgresSessionLog(app.handles.prisma);
    const entries = [];
    for (const draft of drafts) {
      entries.push(
        await app.handles.prisma.$transaction((tx) =>
          log.append(tx, { ...draft, sessionId, feedBotId } as SessionEntryDraft),
        ),
      );
    }
    return entries;
  }

  async function compactedUpTo(sessionId: SessionId) {
    const [first] = await new PostgresSessionLog(app.handles.prisma).readTail(sessionId);
    return first?.type === "compaction" ? first.payload.coveredUpToSeq : null;
  }

  function runtime(options: {
    extract: () => Promise<string>;
    beforeExtract?: () => Promise<void>;
  }): AgentRuntime {
    return {
      describe: () => ({
        id: "memory-capture-fixture",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { streaming: true, compaction: true, tools: false, scripted: true },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest, _context?: Partial<AdapterContext>) {
        if (request.runId.startsWith("learn:")) {
          await options.beforeExtract?.();
          yield { type: "done", text: await options.extract() } satisfies AgentRuntimeEvent;
          return;
        }
        yield { type: "done", text: "A short fixture summary." } satisfies AgentRuntimeEvent;
      },
    };
  }

  async function compact(threadId: string, agentRuntime: AgentRuntime) {
    await compactHistory(
      {
        prisma: app.handles.prisma,
        sessionLog: new PostgresSessionLog(app.handles.prisma),
        runtime: agentRuntime,
        memory: new MarkdownMemoryStore(app.handles.prisma),
        resolveModel: async () => ({ provider: "fixture", id: "fixture-model" }),
      },
      threadId,
      // Keeps only the newest exchange word for word: the other 49 messages are compacted.
      1,
    );
  }

  function candidate(sourceMessageId: string, quote: string) {
    return JSON.stringify({
      candidates: [{ fact: "Call the user Rom.", sourceMessageId, quote }],
    });
  }

  it("commits cursor and durable intent together, then retries extraction without duplicate proposals", async () => {
    const fixture = await createCaptureThread();
    let extractionAttempts = 0;
    const agentRuntime = runtime({
      extract: async () => {
        extractionAttempts += 1;
        if (extractionAttempts === 1) throw new Error("scripted extractor interruption");
        return candidate(fixture.sourceId, fixture.sourceText);
      },
    });

    await compact(fixture.threadId, agentRuntime);

    const pending = await app.handles.prisma.memoryCaptureRequest.findFirstOrThrow({
      where: { threadId: fixture.threadId },
    });
    expect(await compactedUpTo(fixture.sessionId)).toBe(48);
    expect(pending).toMatchObject({ status: "pending", attempts: 1, candidates: null });
    expect(pending.availableAt.getTime()).toBeGreaterThan(Date.now());

    await app.handles.prisma.memoryCaptureRequest.update({
      where: { id: pending.id },
      data: { availableAt: new Date(0) },
    });
    await compact(fixture.threadId, agentRuntime);
    const completed = await app.handles.prisma.memoryCaptureRequest.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(completed.status).toBe("completed");
    const proposals = await app.handles.prisma.memoryDocument.findMany({
      where: { botId: fixture.botId, status: "proposed", content: "Call the user Rom." },
    });
    expect(proposals).toHaveLength(1);
    expect(
      await app.handles.prisma.memoryEvidence.count({ where: { documentId: proposals[0]!.id } }),
    ).toBe(1);

    await new MarkdownMemoryLibrary(app.handles.prisma).withdraw(
      fixture.member.actor,
      proposals[0]!.id,
      proposals[0]!.revision,
    );
    await compact(fixture.threadId, agentRuntime);
    expect(
      await app.handles.prisma.memoryDocument.count({
        where: { botId: fixture.botId, content: "Call the user Rom." },
      }),
    ).toBe(1);
  });

  it("does not advance the cursor when the capture intent cannot be inserted", async () => {
    const fixture = await createCaptureThread();
    const idempotencyKey = `capture:${createHash("sha256")
      .update(`${fixture.sessionId}\n0\n-1\n48\nmemory-capture-v1`)
      .digest("hex")}`;
    await app.handles.prisma.memoryCaptureRequest.create({
      data: {
        idempotencyKey,
        threadId: fixture.threadId,
        botId: fixture.botId,
        spaceId: fixture.member.actor.spaceId,
        userId: fixture.member.actor.userId,
        historyGeneration: 0,
        fromSeqExclusive: -1,
        toSeqInclusive: 48,
        sourceMessages: [],
        memoryManifest: [],
        status: "failed",
      },
    });

    await expect(
      compact(fixture.threadId, runtime({ extract: async () => '{"candidates":[]}' })),
    ).rejects.toThrow();

    expect(await compactedUpTo(fixture.sessionId)).toBeNull();
    expect(
      await app.handles.prisma.memoryCaptureRequest.count({
        where: { threadId: fixture.threadId },
      }),
    ).toBe(1);
  });

  it.each(["membership", "history generation"] as const)(
    "stales a capture when %s changes during extraction",
    async (changed) => {
      const fixture = await createCaptureThread();
      let extractionStarted!: () => void;
      let allowExtraction!: () => void;
      const started = new Promise<void>((resolve) => {
        extractionStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        allowExtraction = resolve;
      });
      const agentRuntime = runtime({
        beforeExtract: async () => {
          extractionStarted();
          await gate;
        },
        extract: async () => candidate(fixture.sourceId, fixture.sourceText),
      });
      const running = compact(fixture.threadId, agentRuntime);
      await started;
      if (changed === "membership") {
        await app.handles.prisma.spaceMember.deleteMany({
          where: { spaceId: fixture.member.actor.spaceId, userId: fixture.member.actor.userId },
        });
      } else {
        // A clear starts a new history generation: what was captured from before it is gone.
        await append(fixture.sessionId, [{ type: "clear", payload: {} }], fixture.botId);
      }
      allowExtraction();
      await running;

      const request = await app.handles.prisma.memoryCaptureRequest.findFirstOrThrow({
        where: { threadId: fixture.threadId },
      });
      expect(request.status).toBe("stale");
      expect(
        await app.handles.prisma.memoryDocument.count({ where: { botId: fixture.botId } }),
      ).toBe(0);
    },
  );
});
