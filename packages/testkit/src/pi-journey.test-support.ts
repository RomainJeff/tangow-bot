import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, PostgresSessionLog } from "@rakazo/adapters";
import type { AskDraftEdits, SessionEntry, SessionId } from "@rakazo/contracts";
import { SessionId as SessionIdSchema } from "@rakazo/contracts";
import { expect } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Handles = Awaited<ReturnType<typeof createApp>>;
const fixtureOrigin = "http://127.0.0.1:5173";
export const fixtureKey = "offline-product-fixture-key";

/** What the model tells the person, which only message_user carries. */
export function reply(message: string, id = "journey-reply") {
  return { type: "tool", id, name: "message_user", arguments: { message } } as const;
}

/** The model's turn after its message_user call, with nothing left to say. */
export const DONE: ModelEmulatorStep = { expect() {}, response: { type: "text", text: "" } };

export function payloadOf(entry: SessionEntry | undefined) {
  return (entry?.payload ?? {}) as Record<string, unknown>;
}

export type JourneyFixture = {
  app: App;
  cookie: string;
  bot: { id: string };
  userId: string;
  prisma: Handles["prisma"];
  log: PostgresSessionLog;
  send: (
    text: string,
    options?: {
      replyToMessageId?: string;
      replyQuote?: string;
      clientNonce?: string;
      draft?: AskDraftEdits & { messageId: string; text: string };
    },
  ) => Promise<{
    runId: string;
    sessionId: SessionId;
    executionSessionId: () => Promise<SessionId>;
    settled: (status: string) => Promise<void>;
  }>;
};

export async function journey(
  steps: ModelEmulatorStep[],
  drive: (fixture: JourneyFixture) => Promise<void>,
  app: Pick<
    NonNullable<Parameters<typeof createApp>[0]>,
    "agentRuntime" | "skillLearning" | "composio"
  > = {},
) {
  const model = await startModelEmulator({ apiKey: fixtureKey, steps });
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-product-"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: fixtureOrigin,
      webOrigin: fixtureOrigin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "offline-model-fixture-encryption-key",
      ...app,
    });
    stop = handles.stop;
    const email = `offline-pi-${randomUUID()}@rakazo.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixtureOrigin },
      body: JSON.stringify({ email, password: "password12", name: "Offline fixture" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const user = await handles.prisma.user.findUniqueOrThrow({ where: { email } });
    await rpc(handles.app, cookie, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      apiKey: fixtureKey,
    });
    const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
      name: "File fixture",
      title: "",
      description: "",
      instructions: "Complete the task.",
      notifyOnFinish: false,
    });
    await rpc(handles.app, cookie, "bots/update", {
      botId: bot.id,
      modelProvider: model.model.provider,
      modelId: model.model.id,
    });
    await drive({
      app: handles.app,
      cookie,
      bot,
      userId: user.id,
      prisma: handles.prisma,
      log: new PostgresSessionLog(handles.prisma),
      async send(text, options) {
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text,
          ...options,
        });
        const thread = await handles.prisma.thread.findFirstOrThrow({
          where: { botId: bot.id },
          select: { sessionId: true },
        });
        return {
          runId: sent.runId,
          sessionId: thread.sessionId as SessionId,
          async executionSessionId() {
            const run = await handles.prisma.run.findUniqueOrThrow({
              where: { id: sent.runId },
              select: { sessionId: true },
            });
            return SessionIdSchema.parse(run.sessionId);
          },
          async settled(status) {
            await expect
              .poll(
                async () => {
                  const run = await handles.prisma.run.findUnique({
                    where: { id: sent.runId },
                    select: { status: true },
                  });
                  if (run?.status === "failed") model.assertComplete();
                  return run?.status;
                },
                { timeout: 15_000, interval: 100 },
              )
              .toBe(status);
          },
        };
      },
    });
    model.assertComplete();
  } finally {
    try {
      await stop?.();
    } finally {
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

export async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
