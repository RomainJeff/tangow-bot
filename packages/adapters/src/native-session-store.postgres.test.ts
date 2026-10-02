import { randomUUID } from "node:crypto";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNativeSessionHost } from "./native-session-host.js";
import type { NativeSessionStore } from "./native-session-store.js";
import { createNativeSessionStore } from "./native-session-store.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("native session store durable generation fence (T03)", () => {
  let store: NativeSessionStore;
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb(databaseUrl!);
    store = createNativeSessionStore(db.prisma);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("allows exactly one concurrent reconstruction and selects resume, reconstruct, and stop refusal from durable state", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const placement = "computer-test";
    const first = { bindingId: threadId, generation: 0 };
    await store.record({
      botId,
      threadId,
      ref: first,
      nativeRef: "native-thread",
      harness: "codex-native",
      executionTarget: placement,
      continuity: "new",
    });
    await store.park({ botId, threadId, ref: first });
    await expect(
      store.continuity({
        botId,
        threadId,
        harness: "codex-native",
        executionTarget: placement,
        inputId: "input-1",
      }),
    ).resolves.toEqual({
      mode: "resume",
      ref: first,
      inputId: "input-1",
      nativeRef: "native-thread",
    });

    const next = { bindingId: threadId, generation: 1 };
    const writes = await Promise.allSettled([
      store.record({
        botId,
        threadId,
        ref: next,
        nativeRef: "native-thread",
        harness: "codex-native",
        executionTarget: placement,
        continuity: "reconstructed",
      }),
      store.record({
        botId,
        threadId,
        ref: next,
        nativeRef: "native-thread",
        harness: "codex-native",
        executionTarget: placement,
        continuity: "reconstructed",
      }),
    ]);
    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    await expect(
      store.continuity({
        botId,
        threadId,
        harness: "codex-native",
        executionTarget: placement,
        inputId: "input-2",
      }),
    ).resolves.toMatchObject({ mode: "reconstruct", previous: next, nativeRef: "native-thread" });

    await store.stopUnconfirmed({ botId, threadId, ref: next });
    await expect(
      store.continuity({
        botId,
        threadId,
        harness: "codex-native",
        executionTarget: placement,
        inputId: "input-3",
      }),
    ).rejects.toMatchObject({ code: "harness_unavailable", message: "previous_stop_unconfirmed" });
  });

  it("never hands a native reference to another harness or Computer", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const placement = "computer-test";
    const ref = (generation: number) => ({ bindingId: threadId, generation });
    const continuity = (harness: "codex-native" | "claude-native", inputId: string) =>
      store.continuity({ botId, threadId, harness, executionTarget: placement, inputId });
    await store.record({
      botId,
      threadId,
      ref: ref(0),
      nativeRef: "codex-thread",
      harness: "codex-native",
      executionTarget: placement,
      continuity: "new",
    });
    await store.park({ botId, threadId, ref: ref(0) });

    await expect(continuity("claude-native", "input-1")).resolves.toEqual({
      mode: "new",
      ref: ref(1),
    });
    await store.record({
      botId,
      threadId,
      ref: ref(1),
      nativeRef: "claude-session",
      harness: "claude-native",
      executionTarget: placement,
      continuity: "new",
    });
    await store.park({ botId, threadId, ref: ref(1) });

    await expect(continuity("codex-native", "input-2")).resolves.toEqual({
      mode: "new",
      ref: ref(2),
    });
    await expect(continuity("claude-native", "input-3")).resolves.toMatchObject({
      mode: "resume",
      nativeRef: "claude-session",
    });
  });

  it("records a missing rollout as an explicit expired lifecycle outcome", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const ref = { bindingId: threadId, generation: 0 };
    await store.record({
      botId,
      threadId,
      ref,
      nativeRef: "missing-rollout-thread",
      harness: "codex-native",
      executionTarget: "computer-test",
      continuity: "new",
    });
    await store.park({ botId, threadId, ref });

    await store.rolloutMissing({ botId, threadId, ref });

    await expect(
      db.prisma.nativeSession.findUniqueOrThrow({
        where: { botId_threadId: { botId, threadId } },
      }),
    ).resolves.toMatchObject({ state: "expired", processState: "stopped", nativeRef: null });
    await expect(
      db.prisma.lifecycleEvent.findFirstOrThrow({
        where: { botId, threadId, kind: "resume_rollout_missing" },
      }),
    ).resolves.toBeDefined();
    // The dead reference is gone, so the next run opens a new session instead of retrying it.
    await expect(
      store.continuity({
        botId,
        threadId,
        harness: "codex-native",
        executionTarget: "computer-test",
        inputId: "input-next",
      }),
    ).resolves.toEqual({ mode: "new", ref: { bindingId: threadId, generation: 1 } });
  });

  it("advances an existing unreferenced generation instead of parking with a stale ref", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const placement = "computer-test";
    await db.prisma.nativeSession.create({
      data: { botId, threadId, generation: 7, state: "closed", processState: "stopped" },
    });
    const continuity = await store.continuity({
      botId,
      threadId,
      harness: "codex-native",
      executionTarget: placement,
      inputId: "input",
    });
    const ref = { bindingId: threadId, generation: 8 };
    expect(continuity).toEqual({ mode: "new", ref });
    await store.record({
      botId,
      threadId,
      ref,
      harness: "codex-native",
      executionTarget: placement,
      continuity: "new",
    });
    await store.park({ botId, threadId, ref });
    await expect(
      db.prisma.nativeSession.findUniqueOrThrow({ where: { botId_threadId: { botId, threadId } } }),
    ).resolves.toMatchObject({ generation: 8, state: "parked" });
  });

  it("fills generation zero created by the session host with the first runtime record", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const host = createNativeSessionHost(db.pool);
    await host.ensureBinding(botId, threadId);

    await store.record({
      botId,
      threadId,
      ref: { bindingId: threadId, generation: 0 },
      nativeRef: "native-thread",
      processRef: "native-process",
      harness: "codex-native",
      executionTarget: "computer-test",
      continuity: "new",
    });

    await expect(
      db.prisma.nativeSession.findUniqueOrThrow({ where: { botId_threadId: { botId, threadId } } }),
    ).resolves.toMatchObject({
      harness: "codex-native",
      state: "attached",
      processState: "running",
    });
  });

  it("does not close a newer active binding after the original worker loses its lease", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const placement = "computer-test";
    const first = { bindingId: threadId, generation: 0 };
    await store.record({
      botId,
      threadId,
      ref: first,
      nativeRef: "first-native-thread",
      harness: "codex-native",
      executionTarget: placement,
      continuity: "new",
    });
    await store.park({ botId, threadId, ref: first });
    await db.prisma.nativeSession.update({
      where: { botId_threadId: { botId, threadId } },
      data: { state: "closed", processState: "stopped" },
    });
    const continuity = await store.continuity({
      botId,
      threadId,
      harness: "codex-native",
      executionTarget: placement,
      inputId: "recovery",
    });
    if (continuity.mode !== "reconstruct")
      throw new Error("expected reconstruction after the lost lease");
    const second = { bindingId: threadId, generation: 1 };
    await store.record({
      botId,
      threadId,
      ref: second,
      nativeRef: "second-native-thread",
      harness: "codex-native",
      executionTarget: placement,
      continuity: "reconstructed",
    });

    await expect(
      store.close({ botId, threadId, ref: first, processState: "stopped" }),
    ).rejects.toThrow("native session generation is stale");
    await expect(
      db.prisma.nativeSession.findUniqueOrThrow({ where: { botId_threadId: { botId, threadId } } }),
    ).resolves.toMatchObject({
      generation: 1,
      nativeRef: "second-native-thread",
      state: "attached",
      processState: "running",
    });
  });
});
