import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { MarkdownMemoryLibrary } from "@rakazo/memory";
import { afterAll, beforeAll, expect } from "vitest";
import { sessionCookieHeader } from "./index.js";

export const memoryDatabaseAvailable =
  process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

export type MemoryMember = { cookie: string; actor: Actor };
/** A memory as the library API returns it, as far as the journeys read it. */
export type Memory = {
  id: string;
  title: string;
  content: string;
  revision: number;
  status: string;
  canEdit: boolean;
  canWithdraw: boolean;
};
export type Library = { items: Array<Omit<Memory, "content">>; nextCursor?: string | null };

type AppHandles = {
  app: { request(path: string, init: RequestInit): Response | Promise<Response> };
  prisma: PrismaClient;
  stop(): Promise<void>;
};
/** The API's `createApp`, loaded by the suite: this package does not compile the API. */
type LoadApp = () => Promise<{ createApp(options: Record<string, unknown>): Promise<AppHandles> }>;

/** The API app on the test database for one memory suite, started before and stopped after it. */
export function useMemoryApp(
  prefix: string,
  loadApp: LoadApp,
  options: Record<string, unknown> = {},
) {
  let dataDir = "";
  const app = {
    handles: undefined as unknown as AppHandles,
    library: undefined as unknown as MarkdownMemoryLibrary,
    raw,
    rpc,
    signup,
    join,
  };
  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), `rakazo-${prefix}-`));
    const { createApp } = await loadApp();
    app.handles = await createApp({
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
      ...options,
    });
    app.library = new MarkdownMemoryLibrary(app.handles.prisma);
  });
  afterAll(async () => {
    await app.handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  function raw(
    member: MemoryMember,
    procedure: string,
    input: unknown,
    spaceId = member.actor.spaceId,
  ) {
    return app.handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: member.cookie,
        origin,
        "x-rakazo-space-id": spaceId,
      },
      body: JSON.stringify({ json: input }),
    });
  }

  async function rpc<T>(
    member: MemoryMember,
    procedure: string,
    input: unknown,
    spaceId = member.actor.spaceId,
  ): Promise<T> {
    const response = await raw(member, procedure, input, spaceId);
    const body = await response.json();
    expect(response.status, `${procedure}: ${JSON.stringify(body)}`).toBeLessThan(400);
    return body.json;
  }

  async function signup(name = "Memory Fixture"): Promise<MemoryMember> {
    const response = await app.handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `${prefix}-${randomUUID()}@rakazo.test`,
        password: "password12",
        name,
      }),
    });
    expect(response.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(response);
    const me = await app.handles.app.request("/rpc/me", {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify({ json: {} }),
    });
    expect(me.status).toBe(200);
    return { cookie, actor: (await me.json()).json };
  }

  /** Make `userId` a plain member of the Space `spaceId`. */
  async function join(userId: string, spaceId: string) {
    const { prisma } = app.handles;
    const { organizationId } = await prisma.space.findUniqueOrThrow({
      where: { id: spaceId },
      select: { organizationId: true },
    });
    await prisma.member.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      update: {},
      create: { id: randomUUID(), organizationId, userId, role: "member", createdAt: new Date() },
    });
    await prisma.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId } },
      update: { role: "member" },
      create: {
        id: randomUUID(),
        organizationId,
        spaceId,
        userId,
        role: "member",
        createdAt: new Date(),
      },
    });
  }

  return app;
}
