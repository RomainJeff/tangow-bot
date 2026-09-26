import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { ComposioEmulator } from "@rakazo/adapters";
import { MarkdownMemoryStore } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactHistory } from "../../adapters/src/history-compaction.js";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;
type Member = { cookie: string; userId: string; spaceId: string };
const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

let createApp: typeof import("../../../apps/api/src/app.ts").createApp;
describe.skipIf(!available)("durable memory capture (PostgreSQL)", () => {
  let handles: AppHandles;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-memory-capture-"));
    ({ createApp } = await import("../../../apps/api/src/app.ts"));
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "offline-memory-capture-fixture-key",
    });
  });

  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function signup(): Promise<Member> {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `memory-capture-${randomUUID()}@rakazo.test`,
        password: "password12",
        name: "Capture Fixture",
      }),
    });
    expect(response.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(response);
    const me = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: {} }),
    });
    expect(me.status).toBe(200);
    const actor = (await me.json()).json;
    return { cookie, userId: actor.userId, spaceId: actor.spaceId };
  }

  async function rpc<T>(member: Member, procedure: string, input: unknown): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: member.cookie,
        origin,
        "x-rakazo-space-id": member.spaceId,
      },
      body: JSON.stringify({ json: input }),
    });
    const body = await response.json();
    expect(response.status, `${procedure}: ${JSON.stringify(body)}`).toBeLessThan(400);
    return body.json;
  }

  async function createCaptureThread() {
    const member = await signup();
    const bot = await rpc<{ id: string }>(member, "bots/create", {
      name: "Capture Fixture Bot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await handles.prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const sourceText = "Please call me Rom.";
    await handles.prisma.message.createMany({
      data: Array.from({ length: 50 }, (_, seq) => ({
        id: randomUUID(),
        threadId: thread.id,
        seq,
        role: "user",
        blocks: [{ kind: "text", text: seq === 0 ? sourceText : `Fixture message ${seq}.` }],
      })),
    });
    await handles.prisma.thread.update({ where: { id: thread.id }, data: { nextMessageSeq: 50 } });
    return { member, botId: bot.id, threadId: thread.id, sourceText };
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
        prisma: handles.prisma,
        runtime: agentRuntime,
        jobs: { enqueue: async () => undefined } as never,
        memory: new MarkdownMemoryStore(handles.prisma),
        memoryProviders: { resolve: async () => null },
        resolveModel: async () => ({ provider: "fixture", id: "fixture-model" }),
      },
      threadId,
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
        return candidate(
          (
            await handles.prisma.message.findFirstOrThrow({
              where: { threadId: fixture.threadId, seq: 0 },
              select: { id: true },
            })
          ).id,
          fixture.sourceText,
        );
      },
    });

    await compact(fixture.threadId, agentRuntime);

    const thread = await handles.prisma.thread.findUniqueOrThrow({
      where: { id: fixture.threadId },
    });
    const pending = await handles.prisma.memoryCaptureRequest.findFirstOrThrow({
      where: { threadId: fixture.threadId },
    });
    expect(thread.historyCompactedUpToSeq).toBe(49);
    expect(pending).toMatchObject({ status: "pending", attempts: 1, candidates: null });
    expect(pending.availableAt.getTime()).toBeGreaterThan(Date.now());

    await handles.prisma.memoryCaptureRequest.update({
      where: { id: pending.id },
      data: { availableAt: new Date(0) },
    });
    await compact(fixture.threadId, agentRuntime);
    const completed = await handles.prisma.memoryCaptureRequest.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(completed.status).toBe("completed");
    const proposals = await handles.prisma.memoryDocument.findMany({
      where: { botId: fixture.botId, status: "proposed", content: "Call the user Rom." },
    });
    expect(proposals).toHaveLength(1);
    expect(
      await handles.prisma.memoryEvidence.count({ where: { documentId: proposals[0]!.id } }),
    ).toBe(1);

    await rpc(fixture.member, "memory/library/withdraw", {
      documentId: proposals[0]!.id,
      expectedRevision: proposals[0]!.revision,
    });
    await compact(fixture.threadId, agentRuntime);
    expect(
      await handles.prisma.memoryDocument.count({
        where: { botId: fixture.botId, content: "Call the user Rom." },
      }),
    ).toBe(1);
  });

  it("does not advance the cursor when the capture intent cannot be inserted", async () => {
    const fixture = await createCaptureThread();
    const idempotencyKey = `capture:${createHash("sha256")
      .update(`${fixture.threadId}\n0\n-1\n49\nmemory-capture-v1`)
      .digest("hex")}`;
    await handles.prisma.memoryCaptureRequest.create({
      data: {
        idempotencyKey,
        threadId: fixture.threadId,
        botId: fixture.botId,
        spaceId: fixture.member.spaceId,
        userId: fixture.member.userId,
        historyGeneration: 0,
        fromSeqExclusive: -1,
        toSeqInclusive: 49,
        sourceMessages: [],
        memoryManifest: [],
        status: "failed",
      },
    });

    await expect(
      compact(fixture.threadId, runtime({ extract: async () => '{"candidates":[]}' })),
    ).rejects.toThrow();

    const thread = await handles.prisma.thread.findUniqueOrThrow({
      where: { id: fixture.threadId },
    });
    expect(thread.historyCompactedUpToSeq).toBeNull();
    expect(
      await handles.prisma.memoryCaptureRequest.count({ where: { threadId: fixture.threadId } }),
    ).toBe(1);
  });

  it.each(["membership", "source"] as const)(
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
        extract: async () =>
          candidate(
            (
              await handles.prisma.message.findFirstOrThrow({
                where: { threadId: fixture.threadId, seq: 0 },
                select: { id: true },
              })
            ).id,
            fixture.sourceText,
          ),
      });
      const running = compact(fixture.threadId, agentRuntime);
      await started;
      if (changed === "membership") {
        await handles.prisma.spaceMember.deleteMany({
          where: { spaceId: fixture.member.spaceId, userId: fixture.member.userId },
        });
      } else {
        await handles.prisma.message.updateMany({
          where: { threadId: fixture.threadId, seq: 0 },
          data: { blocks: [{ kind: "text", text: "Changed while extracting." }] },
        });
      }
      allowExtraction();
      await running;

      const request = await handles.prisma.memoryCaptureRequest.findFirstOrThrow({
        where: { threadId: fixture.threadId },
      });
      expect(request.status).toBe("stale");
      expect(await handles.prisma.memoryDocument.count({ where: { botId: fixture.botId } })).toBe(
        0,
      );
    },
  );
});
