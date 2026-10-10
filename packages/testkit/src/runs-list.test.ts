import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BotActivityOutput, Routine, RunActivityRow, RunRecap } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeRunsList = hasDb ? describe : describe.skip;

describeRunsList("runs.list activity tracker", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-runs-list-"));

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = handles.prisma;
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("lists active runs from two bots and keeps completed runs under recent", async () => {
    const cookie = await signup(app, `runs-${stamp}@rakazo.test`, "Runs User");
    const alpha = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Alpha",
      title: "Alpha",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const beta = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Beta",
      title: "Beta",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "bots/update", { botId: beta.id, notifyOnFinish: false });

    await seedRun(prisma, alpha.id, "running", "alpha in flight");
    await seedRun(prisma, beta.id, "queued", "beta in flight");
    await seedRun(prisma, alpha.id, "completed", "alpha done");

    const active = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "active",
    });
    expect(active.runs.map((run) => run.botName).sort()).toEqual(["Alpha", "Beta"]);
    expect(active.runs.find((run) => run.botName === "Beta")?.notificationsEnabled).toBe(false);
    expect(active.runs.some((run) => run.status === "completed")).toBe(false);

    const recent = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "recent",
    });
    expect(recent.runs.some((run) => run.botName === "Alpha" && run.status === "completed")).toBe(
      true,
    );
    expect(recent.runs.some((run) => run.botName === "Beta")).toBe(false);
  });

  it("never returns runs from another workspace", async () => {
    const ownerCookie = await signup(app, `runs-owner-${stamp}@rakazo.test`, "Owner");
    const ownerBot = await rpc<{ id: string }>(app, ownerCookie, "bots/create", {
      name: "OwnerBot",
      title: "OwnerBot",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await seedRun(prisma, ownerBot.id, "running", "owner active run");

    const intruderCookie = await signup(app, `runs-intruder-${stamp}@rakazo.test`, "Intruder");
    const active = await rpc<{ runs: RunActivityRow[] }>(app, intruderCookie, "runs/list", {
      filter: "active",
    });
    expect(active.runs).toEqual([]);
  });

  it("excludes archived bots from recent before applying the limit", async () => {
    const cookie = await signup(app, `runs-archived-${stamp}@rakazo.test`, "Archive User");
    const archivedBot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Archived",
      title: "Archived",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const visibleBot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Visible",
      title: "Visible",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "bots/archive", { botId: archivedBot.id });
    const olderVisibleAt = new Date(Date.now() - 86_400_000);
    for (let i = 0; i < 21; i += 1) {
      await seedRun(
        prisma,
        archivedBot.id,
        "completed",
        `archived filler ${i}`,
        new Date(Date.now() - i * 1_000),
      );
    }
    await seedRun(prisma, visibleBot.id, "completed", "visible run", olderVisibleAt);

    const recent = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "recent",
    });
    expect(recent.runs.some((run) => run.botName === "Archived")).toBe(false);
    expect(recent.runs.some((run) => run.botName === "Visible")).toBe(true);
    expect(recent.runs.length).toBe(1);
  });

  it("lists each routine with how its latest finished run ended, by completion time", async () => {
    const cookie = await signup(app, `runs-last-${stamp}@rakazo.test`, "Last Run User");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Digest",
      title: "Digest",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = (name: string) =>
      rpc<Routine>(app, cookie, "routines/create", {
        botId: bot.id,
        name,
        prompt: "check",
        crons: ["0 9 * * *"],
      });
    const failing = await routine("Failing");
    const recovered = await routine("Recovered");
    const running = await routine("Running");
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    // Created last but finished first: the order is completion time, not creation.
    await seedRun(
      prisma,
      bot.id,
      "failed",
      "late",
      minutesAgo(1),
      failing.id,
      "429 Too Many Requests",
    );
    await seedRun(prisma, bot.id, "completed", "early", minutesAgo(30), failing.id);
    await seedRun(prisma, bot.id, "completed", "now ok", minutesAgo(1), recovered.id);
    await seedRun(
      prisma,
      bot.id,
      "failed",
      "was broken",
      minutesAgo(30),
      recovered.id,
      "Bot has no computer",
    );
    await seedRun(prisma, bot.id, "running", "in flight", null, running.id);

    const listed = await rpc<Routine[]>(app, cookie, "routines/list", { botId: bot.id });
    expect(
      listed
        .map((item) => [item.name, item.lastRunStatus, item.lastRunFailureKind])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ["Failing", "failed", "provider"],
      ["Recovered", "succeeded", null],
      ["Running", null, null],
    ]);
    expect(JSON.stringify(listed)).not.toContain("Too Many Requests");

    const renamed = await rpc<Routine>(app, cookie, "routines/update", {
      routineId: failing.id,
      name: "Still failing",
    });
    expect([renamed.lastRunStatus, renamed.lastRunFailureKind]).toEqual(["failed", "provider"]);
  });

  it("never returns another user's activity or recap for a foreign bot or run", async () => {
    const ownerCookie = await signup(app, `runs-scope-owner-${stamp}@rakazo.test`, "Owner");
    const ownerBot = await createBot(app, ownerCookie, "ScopeBot");
    const routine = await prisma.routine.create({
      data: await routineData(prisma, ownerBot.id, "Owner digest"),
    });
    await seedRun(prisma, ownerBot.id, "running", "owner active", null, routine.id);
    const done = await seedRun(
      prisma,
      ownerBot.id,
      "completed",
      "owner done",
      undefined,
      routine.id,
    );
    await seedBotMessage(prisma, done, "Owner's private report");

    const intruderCookie = await signup(
      app,
      `runs-scope-intruder-${stamp}@rakazo.test`,
      "Intruder",
    );
    const ownBot = await createBot(app, intruderCookie, "IntruderBot");
    await seedRun(prisma, ownBot.id, "completed", "intruder done");

    for (const input of [
      { botId: ownerBot.id },
      {
        botId: ownerBot.id,
        cursor: { createdAt: new Date(Date.now() + 60_000).toISOString(), id: "zzzzzzzz" },
      },
    ]) {
      const response = await raw(app, intruderCookie, "bots/activity", input);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain("Owner digest");
    }
    const recap = await raw(app, intruderCookie, "runs/recap", { runId: done.id });
    expect(recap.status).toBeGreaterThanOrEqual(400);
    expect(await recap.text()).not.toContain("private report");

    const mine = await rpc<BotActivityOutput>(app, ownerCookie, "bots/activity", {
      botId: ownerBot.id,
    });
    expect(
      mine.items.map((item) =>
        item.kind === "routine_run" ? [item.run.status, item.run.routineName] : item.kind,
      ),
    ).toEqual([
      ["running", "Owner digest"],
      ["completed", "Owner digest"],
      "routine_created",
      "bot_created",
    ]);
    expect(await rpc<RunRecap>(app, ownerCookie, "runs/recap", { runId: done.id })).toEqual({
      text: "Owner's private report",
      messageId: expect.any(String),
    });
  });

  it("lists a bot's routine runs, routine creations and its own creation, never other runs", async () => {
    const cookie = await signup(app, `activity-feed-${stamp}@rakazo.test`, "Feed User");
    const bot = await createBot(app, cookie, "Feed Bot");
    const botRow = await prisma.bot.update({
      where: { id: bot.id },
      data: { createdAt: new Date(Date.now() - 600_000) },
    });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const mine = await prisma.routine.create({
      data: {
        ...(await routineData(prisma, bot.id, "Mine")),
        createdAt: new Date(Date.now() - 500_000),
      },
    });
    const proposed = await prisma.routine.create({
      data: {
        ...(await routineData(prisma, bot.id, "Proposed")),
        threadId: thread.id,
        createdAt: new Date(Date.now() - 400_000),
      },
    });
    const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000);
    const chat = await seedRun(prisma, bot.id, "completed", "person asked");
    const scheduled = await seedRun(prisma, bot.id, "completed", "digest", undefined, mine.id);
    const hook = await seedRun(prisma, bot.id, "completed", "hook", undefined, proposed.id);
    await prisma.run.update({ where: { id: hook.id }, data: { trigger: "webhook" } });
    const orphan = await seedRun(prisma, bot.id, "completed", "deleted routine");
    await prisma.run.update({ where: { id: orphan.id }, data: { trigger: "routine" } });
    // A deleted routine's webhook wake reads like a plain webhook message: it is left out.
    const orphanHook = await seedRun(prisma, bot.id, "completed", "deleted webhook routine");
    await prisma.run.update({ where: { id: orphanHook.id }, data: { trigger: "webhook" } });
    for (const [run, secondsAgo] of [
      [chat, 50],
      [scheduled, 300],
      [hook, 200],
      [orphan, 100],
    ] as const) {
      await prisma.run.update({ where: { id: run.id }, data: { createdAt: at(secondsAgo) } });
    }

    const first = await rpc<BotActivityOutput>(app, cookie, "bots/activity", {
      botId: bot.id,
      limit: 3,
    });
    const label = (item: BotActivityOutput["items"][number]) =>
      item.kind === "routine_run"
        ? `run:${item.run.runId}`
        : item.kind === "routine_created"
          ? `created:${item.routineName}:${item.byBotName ?? "you"}`
          : `bot:${item.botName}`;
    expect(first.items.map(label)).toEqual([
      `run:${orphan.id}`,
      `run:${hook.id}`,
      `run:${scheduled.id}`,
    ]);
    // A finished run is still written to (mirrored to team chat); that must not move it off its page.
    await prisma.run.update({ where: { id: hook.id }, data: { teamChatMirroredAt: new Date() } });
    const second = await rpc<BotActivityOutput>(app, cookie, "bots/activity", {
      botId: bot.id,
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(second.items.map(label)).toEqual([
      "created:Proposed:Feed Bot",
      "created:Mine:you",
      "bot:Feed Bot",
    ]);
    expect(second.nextCursor).toBeNull();
    expect(second.items.at(-1)).toMatchObject({ createdAt: botRow.createdAt.toISOString() });
  });

  it("lists one routine's runs only for its own bot and owner", async () => {
    const ownerCookie = await signup(app, `routine-runs-owner-${stamp}@rakazo.test`, "Owner");
    const bot = await createBot(app, ownerCookie, "Digest Bot");
    const otherBot = await createBot(app, ownerCookie, "Other Bot");
    const digest = await prisma.routine.create({
      data: await routineData(prisma, bot.id, "Digest"),
    });
    const sweep = await prisma.routine.create({ data: await routineData(prisma, bot.id, "Sweep") });
    const elsewhere = await prisma.routine.create({
      data: await routineData(prisma, otherBot.id, "Elsewhere"),
    });
    const live = await seedRun(prisma, bot.id, "running", "digest live", null, digest.id);
    const done = await seedRun(prisma, bot.id, "completed", "digest done", undefined, digest.id);
    await seedRun(prisma, bot.id, "completed", "sweep done", undefined, sweep.id);
    await seedRun(prisma, bot.id, "completed", "person asked");
    await seedRun(prisma, otherBot.id, "completed", "elsewhere done", undefined, elsewhere.id);

    const runIds = (output: BotActivityOutput) =>
      output.items.map((item) => (item.kind === "routine_run" ? item.run.runId : item.kind));
    const own = await rpc<BotActivityOutput>(app, ownerCookie, "bots/activity", {
      botId: bot.id,
      routineId: digest.id,
    });
    expect(runIds(own)).toEqual([live.id, done.id]);
    expect(own.nextCursor).toBeNull();

    const crossBot = await rpc<BotActivityOutput>(app, ownerCookie, "bots/activity", {
      botId: bot.id,
      routineId: elsewhere.id,
    });
    expect(crossBot).toEqual({ items: [], nextCursor: null });

    const intruderCookie = await signup(
      app,
      `routine-runs-intruder-${stamp}@rakazo.test`,
      "Intruder",
    );
    const intruderBot = await createBot(app, intruderCookie, "Intruder Bot");
    const foreign = await raw(app, intruderCookie, "bots/activity", {
      botId: bot.id,
      routineId: digest.id,
    });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(await foreign.text()).not.toContain(done.id);
    const throughOwnBot = await rpc<BotActivityOutput>(app, intruderCookie, "bots/activity", {
      botId: intruderBot.id,
      routineId: digest.id,
    });
    expect(throughOwnBot).toEqual({ items: [], nextCursor: null });
  });

  it("leaves a plain webhook message out of a bot's activity", async () => {
    const cookie = await signup(app, `activity-hook-${stamp}@rakazo.test`, "Hook User");
    const bot = await createBot(app, cookie, "Hooked");
    const { secret, path: hookPath } = await rpc<{ secret: string; path: string }>(
      app,
      cookie,
      "bots/rotateWebhookSecret",
      { botId: bot.id },
    );
    const delivered = await app.request(
      hookPath.startsWith("/") ? hookPath : `/api/v1/bots/${bot.id}/webhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ text: "deploy finished" }),
      },
    );
    expect(delivered.status).toBeLessThan(400);
    const runs = await prisma.run.findMany({ where: { botId: bot.id } });
    expect(runs.map((run) => [run.trigger, run.routineId])).toEqual([["webhook", null]]);
    await prisma.run.updateMany({
      where: { botId: bot.id },
      data: { status: "completed", completedAt: new Date() },
    });

    const activity = await rpc<BotActivityOutput>(app, cookie, "bots/activity", { botId: bot.id });
    expect(activity.items.map((item) => item.kind)).toEqual(["bot_created"]);
  });

  it("returns group runs with groupId for navigation", async () => {
    const cookie = await signup(app, `runs-group-${stamp}@rakazo.test`, "Group User");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Worker",
      title: "Worker",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Helper",
      title: "Helper",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
      name: "Ops",
      botIds: [botA.id, botB.id],
    });
    const groupThread = await prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: groupThread.spaceId,
        userId: groupThread.userId,
        botId: botA.id,
        threadId: groupThread.id,
        prompt: "group task in flight",
        status: "running",
      },
    });
    await prisma.run.create({
      data: {
        spaceId: groupThread.spaceId,
        userId: groupThread.userId,
        botId: botA.id,
        threadId: groupThread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });

    const active = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "active",
    });
    const groupRun = active.runs.find((run) => run.groupId === group.id);
    expect(groupRun).toBeTruthy();
    expect(groupRun?.groupName).toBe("Ops");
    expect(groupRun?.botId).toBe(botA.id);
  });
});

async function seedRun(
  prisma: PrismaClient,
  botId: string,
  status: "queued" | "running" | "completed" | "failed",
  prompt: string,
  completedAt?: Date | null,
  routineId?: string,
  error?: string,
) {
  const thread = await prisma.thread.findUniqueOrThrow({ where: { botId } });
  const task = await prisma.task.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      prompt,
      status,
    },
  });
  return prisma.run.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      taskId: task.id,
      status,
      trigger: routineId ? "routine" : "user",
      routineId,
      error,
      completedAt:
        status === "completed" || status === "failed" ? (completedAt ?? new Date()) : null,
    },
  });
}

async function seedBotMessage(
  prisma: PrismaClient,
  run: { id: string; threadId: string },
  text: string,
) {
  const last = await prisma.message.findFirst({
    where: { threadId: run.threadId },
    orderBy: { seq: "desc" },
  });
  return prisma.message.create({
    data: {
      threadId: run.threadId,
      seq: (last?.seq ?? 0) + 1,
      role: "bot",
      blocks: [{ kind: "text", text }],
      runId: run.id,
    },
  });
}

async function createBot(app: App, cookie: string, name: string) {
  return rpc<{ id: string }>(app, cookie, "bots/create", {
    name,
    title: name,
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
}

async function routineData(prisma: PrismaClient, botId: string, name: string) {
  const bot = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
  return { spaceId: bot.spaceId, userId: bot.userId, botId, name, prompt: "digest", crons: [] };
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function raw(app: App, cookie: string, proc: string, body: unknown) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}
