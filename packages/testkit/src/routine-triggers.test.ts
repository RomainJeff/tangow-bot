import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ScheduleToolDeps, updateRoutine } from "@tangow/adapters";
import type { Routine } from "@tangow/contracts";
import type { PrismaClient } from "@tangow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("routine triggers", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "tangow-routine-triggers-"));

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

  it("keeps a trigger when two edits each remove a different one", async () => {
    const cookie = await signup(app, `routine-triggers-${Date.now()}@tangow.test`);
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Hooks",
      title: "Hooks",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<Routine>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "On push",
      prompt: "check",
      crons: [],
      webhookEnabled: true,
      githubEnabled: true,
    });
    // Both edits read the routine with its two triggers before either saved.
    const stale = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });

    await rpc(app, cookie, "routines/update", { routineId: routine.id, githubEnabled: false });
    const deps = {
      prisma,
      jobs: { enqueue: async () => undefined, cancel: async () => undefined },
      events: { append: async () => undefined },
    } as unknown as ScheduleToolDeps;
    const second = await updateRoutine(
      deps,
      stale,
      { webhookEnabled: false },
      {
        spaceId: stale.spaceId,
        botId: bot.id,
        threadId: null,
      },
    );

    expect(second).toEqual({ error: "Add a schedule, webhook, GitHub, or message trigger" });
    const stored = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect([stored.crons, stored.webhookEnabled, stored.githubEnabled]).toEqual([[], true, false]);
  });
});

async function signup(app: App, email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name: "Trigger User" }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const parsed = JSON.parse(await res.text()) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? JSON.stringify(parsed)}`);
  }
  return parsed.json as T;
}
