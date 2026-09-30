import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobPublisher } from "@rakazo/adapters";
import { createDelegatedTasks } from "@rakazo/adapters";
import type { AuthorizedActor, CommandContext } from "@rakazo/contracts";
import { answerRunInput, pauseRunForInput } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

// NOT RUN in this sandbox (no Docker/Postgres). Terra runs this at verification with:
//   VERIFY_DATABASE=1 DATABASE_URL=<test db> pnpm exec vitest run packages/testkit/src/work-answer.postgres.test.ts
// or through the integration harness, which registers this suite explicitly.
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";
let handles: AppHandles;

const approvalAskBlock = (effectId: string) => ({
  kind: "ask",
  approvalEffectId: effectId,
  text: "Review before computer_act",
  status: "pending",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ],
});

// No approvalEffectId: that is what makes it a secret ask, refused by works.answer.
const secretAskBlock = () => ({
  kind: "ask",
  text: "Enter your API key",
  input: "secret",
  purpose: "api_key",
  status: "pending",
});

describe.skipIf(!databaseAvailable)("delegated work answer from the coordinator thread", () => {
  let dataDir: string;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-work-answer-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: fixtureOrigin,
      webOrigin: fixtureOrigin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      encryptionKey: "offline-work-answer-fixture-encryption-key",
    });
    stop = handles.stop;
  });
  afterAll(async () => {
    try {
      await stop?.();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("surfaces, settles, and closes a specialist's pending ask from the coordinator thread", async () => {
    const prisma = handles.prisma;
    const {
      ownerCookie,
      coordinator,
      storedCoordinator,
      coordinatorThread,
      receipt,
      effectId,
      delegatedTasks,
      context,
    } = await delegatedAsk(prisma);

    // The coordinator thread received a work.waiting_input refresh event carrying ids
    // only, and no run.waiting_input (which would promote the specialist run to the
    // coordinator's primary run and block its composer).
    const coordinatorEvents = await prisma.event.findMany({
      where: { threadId: coordinatorThread.id, type: "work.waiting_input" },
    });
    expect(coordinatorEvents).toHaveLength(1);
    expect(coordinatorEvents[0]).toMatchObject({
      runId: receipt.runId,
      payload: { workId: receipt.workId, runId: receipt.runId },
    });
    expect(
      await prisma.event.findMany({
        where: { threadId: coordinatorThread.id, type: "run.waiting_input" },
      }),
    ).toHaveLength(0);

    // The coordinator's snapshot shows the pending ask with its provenance, while the
    // coordinator's own summary fields stay untouched by specialist activity.
    const waitingSnapshot = await rpc<{
      run: { id: string } | null;
      activeRuns?: unknown[];
      pendingWork?: Array<{
        workId: string;
        rootWorkId: string;
        depth: number;
        coordinator: { botId: string; name: string };
        specialist: { botId: string; name: string };
        runId: string;
        message: { id: string; blocks: Array<{ kind: string; approvalEffectId?: string }> };
      }>;
    }>(handles.app, ownerCookie, "threads/get", { botId: coordinator.id });
    expect(waitingSnapshot.pendingWork).toHaveLength(1);
    const pending = waitingSnapshot.pendingWork![0]!;
    expect(pending).toMatchObject({
      workId: receipt.workId,
      rootWorkId: receipt.workId,
      depth: 0,
      coordinator: { botId: coordinator.id, name: "Coordinator" },
      specialist: { botId: receipt.botId, name: "Specialist" },
      runId: receipt.runId,
    });
    expect(pending.message.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ask", approvalEffectId: effectId }),
      ]),
    );
    expect(waitingSnapshot.run).toBeNull();
    expect(waitingSnapshot.activeRuns).toBeUndefined();

    // Freeze the job queue so the resumed run stays queued and every following
    // assertion reads deterministic committed state instead of racing the worker.
    await (handles.jobs as unknown as { stop(): Promise<void> }).stop();

    // A second user in the same Space is still refused before anything else happens.
    const intruderCookie = await signup(handles.app, "intruder");
    const intruder = await rpc<{ userId: string }>(handles.app, intruderCookie, "me");
    const ownerSpace = await prisma.space.findUniqueOrThrow({
      where: { id: storedCoordinator.spaceId },
      select: { organizationId: true },
    });
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: ownerSpace.organizationId,
        userId: intruder.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await expect(
      prisma.spaceMember.findUniqueOrThrow({
        where: {
          spaceId_userId: {
            spaceId: storedCoordinator.spaceId,
            userId: intruder.userId,
          },
        },
      }),
    ).resolves.toMatchObject({ role: "member" });
    const denied = await raw(
      handles.app,
      intruderCookie,
      "works/answer",
      {
        workId: receipt.workId,
        runId: receipt.runId,
        messageId: pending.message.id,
        answer: "allow",
      },
      storedCoordinator.spaceId,
    );
    await expect(
      prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
    ).resolves.toMatchObject({ status: "intended" });
    await expect(
      prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } }),
    ).resolves.toMatchObject({ status: "waiting_input" });

    // The owner settles the ask from the coordinator thread.
    await rpc(handles.app, ownerCookie, "works/answer", {
      workId: receipt.workId,
      runId: receipt.runId,
      messageId: pending.message.id,
      answer: "allow",
    });
    await expect(
      prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } }),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
    ).resolves.toMatchObject({ status: "approved" });

    // The prompt is no longer awaiting an answer.
    const second = await raw(handles.app, ownerCookie, "works/answer", {
      workId: receipt.workId,
      runId: receipt.runId,
      messageId: pending.message.id,
      answer: "allow",
    });
    expect(second.status).toBe(409);

    // Closing the work removes the pending entry and refuses further answers.
    await delegatedTasks.apply({ kind: "close", workId: receipt.workId }, context);
    const closedSnapshot = await rpc<{ pendingWork?: unknown[] }>(
      handles.app,
      ownerCookie,
      "threads/get",
      { botId: coordinator.id },
    );
    expect(closedSnapshot.pendingWork).toBeUndefined();
    const afterClose = await raw(handles.app, ownerCookie, "works/answer", {
      workId: receipt.workId,
      runId: receipt.runId,
      messageId: pending.message.id,
      answer: "allow",
    });
    expect(afterClose.status).toBeGreaterThanOrEqual(400);
    // Isolation refusals surface as an error response; the exact status is the repo-wide
    // convention (threads.answer behaves the same, expectDenied only requires >= 400).
    expect(denied.status).toBeGreaterThanOrEqual(400);
  }, 45_000);

  it("does not answer a delegated run whose work closed inside the answer window", async () => {
    const prisma = handles.prisma;
    const { storedCoordinator, receipt, effectId } = await delegatedAsk(prisma);
    const askMessage = await prisma.message.findFirst({
      where: { runId: receipt.runId!, role: "bot" },
      select: { id: true },
    });

    // The TOCTOU window: the work closes (a plain committed write — not closeWork, whose
    // cleanup would cancel the run and erase the window) after the ask was surfaced but
    // before the answer transaction runs. The specialist run itself stays waiting_input.
    await prisma.scopedTask.update({
      where: { id: receipt.workId },
      data: { status: "closed" },
    });

    // The packages/db seam the route relies on must answer nothing — the same outcome as
    // a prompt that is no longer waiting — with nothing mutated.
    await expect(
      answerRunInput(prisma, {
        spaceId: storedCoordinator.spaceId,
        threadId: receipt.threadId,
        runId: receipt.runId!,
        messageId: askMessage!.id,
        answeredByUserId: storedCoordinator.userId,
        answer: "allow",
      }),
    ).resolves.toBe(false);
    await expect(
      prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } }),
    ).resolves.toMatchObject({ status: "waiting_input" });
    await expect(
      prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
    ).resolves.toMatchObject({ status: "intended" });
  }, 45_000);

  it("refuses a delegated secret ask from the coordinator thread without any mutation", async () => {
    const prisma = handles.prisma;
    const { ownerCookie, receipt, effectId } = await delegatedAsk(prisma, "secret");
    const askMessage = await prisma.message.findFirst({
      where: { runId: receipt.runId!, role: "bot" },
      select: { id: true },
    });

    // Secrets delegated to a specialist stay in reserve: the coordinator thread refuses
    // the answer up front and nothing moves — no effect change, no run resume, and the
    // submitted value never lands in the message.
    const refused = await raw(handles.app, ownerCookie, "works/answer", {
      workId: receipt.workId,
      runId: receipt.runId,
      messageId: askMessage!.id,
      answer: "sk-live-delegated-secret-value",
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    await expect(
      prisma.run.findUniqueOrThrow({ where: { id: receipt.runId! } }),
    ).resolves.toMatchObject({ status: "waiting_input" });
    await expect(
      prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
    ).resolves.toMatchObject({ status: "intended" });
    const blocks = (
      await prisma.message.findUniqueOrThrow({
        where: { id: askMessage!.id },
        select: { blocks: true },
      })
    ).blocks as Array<{ kind: string; status?: string; answer?: string; input?: string }>;
    expect(blocks[0]).toMatchObject({ kind: "ask", input: "secret", status: "pending" });
    expect(JSON.stringify(blocks)).not.toContain("sk-live-delegated-secret-value");
  }, 45_000);
});

/**
 * A real delegation through the delegation seam, exactly as the executor issues it, then
 * the specialist run parked on a tool approval (or a secret request) the way executor.ts
 * does. Returns the handles each answer scenario needs.
 */
async function delegatedAsk(
  prisma: AppHandles["prisma"],
  variant: "approval" | "secret" = "approval",
) {
  const ownerCookie = await signup(handles.app, "coordinator");
  const coordinator = await rpc<{ id: string }>(handles.app, ownerCookie, "bots/create", {
    name: "Coordinator",
    title: "",
    description: "",
    instructions: "Delegate and follow up.",
    notifyOnFinish: false,
  });
  const storedCoordinator = await prisma.bot.findUniqueOrThrow({
    where: { id: coordinator.id },
  });
  const coordinatorThread = await prisma.thread.findUniqueOrThrow({
    where: { botId: coordinator.id },
  });
  const profile = await prisma.bot.create({
    data: {
      spaceId: storedCoordinator.spaceId,
      userId: storedCoordinator.userId,
      name: "Specialist profile",
      color: "test-color",
      // T04:R1 rejects incompatible native models before spawn. This fixture tests
      // answering asks, not model admission, and requests Codex below.
      modelProvider: "openai-codex",
      modelId: "gpt-5.6",
      thinkingLevel: "low",
    },
  });
  const originTask = await prisma.task.create({
    data: {
      spaceId: storedCoordinator.spaceId,
      userId: storedCoordinator.userId,
      botId: coordinator.id,
      threadId: coordinatorThread.id,
      prompt: "delegate",
      status: "completed",
    },
  });
  const originRun = await prisma.run.create({
    data: {
      spaceId: storedCoordinator.spaceId,
      userId: storedCoordinator.userId,
      botId: coordinator.id,
      threadId: coordinatorThread.id,
      taskId: originTask.id,
      status: "completed",
      trigger: "user",
    },
  });
  const jobs = { enqueue: vi.fn().mockResolvedValue(undefined) } as unknown as JobPublisher;
  const delegatedTasks = createDelegatedTasks({ prisma, jobs });
  const actor: AuthorizedActor = {
    userId: storedCoordinator.userId,
    spaceId: storedCoordinator.spaceId,
    botId: coordinator.id,
    rights: {},
  };
  const context: CommandContext = {
    actor,
    originRunId: originRun.id,
    requestId: randomUUID(),
  };
  const receipt = await delegatedTasks.apply(
    {
      kind: "delegate",
      target: { kind: "from_profile", profileBotId: profile.id, name: "Specialist" },
      harness: { harness: "codex-native", targetId: "native-fixture-target" },
      brief: "Do the delegated thing.",
      requestedRights: {},
      spawnKey: `t09-work-answer-${randomUUID()}`,
    },
    context,
  );
  expect(receipt.runId).toBeTruthy();

  const effectId = randomUUID();
  await prisma.run.update({
    where: { id: receipt.runId! },
    data: { status: "running", leaseOwner: "worker-fixture", leaseFence: 1 },
  });
  const attempt = await prisma.attempt.create({
    data: { runId: receipt.runId!, fence: 1, status: "running" },
  });
  await prisma.externalEffect.create({
    data: {
      id: effectId,
      spaceId: storedCoordinator.spaceId,
      runId: receipt.runId!,
      kind: variant === "secret" ? "request_secret" : "computer_act",
      idempotencyKey: `t09-work-answer-${randomUUID()}`,
      status: "intended",
      request:
        variant === "secret"
          ? { purpose: "api_key" }
          : { actions: [{ kind: "type", text: "approved" }] },
    },
  });
  const paused = await pauseRunForInput(prisma, {
    spaceId: storedCoordinator.spaceId,
    threadId: receipt.threadId,
    botId: receipt.botId,
    runId: receipt.runId!,
    attemptId: attempt.id,
    leaseOwner: "worker-fixture",
    leaseFence: 1,
    blocks: [variant === "secret" ? secretAskBlock() : approvalAskBlock(effectId)],
  });
  expect(paused).toBe(true);

  return {
    ownerCookie,
    coordinator,
    storedCoordinator,
    coordinatorThread,
    receipt,
    effectId,
    delegatedTasks,
    context,
  };
}

async function signup(app: App, label: string): Promise<string> {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: fixtureOrigin },
    body: JSON.stringify({
      email: `work-answer-${label}-${randomUUID()}@rakazo.test`,
      password: "password12",
      name: `Work answer ${label}`,
    }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function raw(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
  spaceId?: string,
): Promise<Response> {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: fixtureOrigin,
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: input }),
  });
}

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await raw(app, cookie, procedure, input);
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
