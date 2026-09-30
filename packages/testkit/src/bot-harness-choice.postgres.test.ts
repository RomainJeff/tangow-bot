import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

/**
 * H2 of T09:5 — a bot whose settings save the codex-native harness gets every
 * plain send executed with that harness, with the choice's own version on the
 * Run. Explicit client choices keep their current behavior.
 */
describe.skipIf(!available)("bot harness choice", () => {
  it("creates the Run with the bot's saved codex-native choice when the send carries none", async () => {
    const model = { provider: "openai-codex", id: "gpt-5.6" };
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-bot-harness-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "graphile",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "bot-harness-test-encryption-key",
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `bot-harness-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Bot harness",
        }),
      });
      const setCookie = signup.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";")[0];
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json?: T; error?: { message?: string } };
        if (!response.ok || body.error)
          throw new Error(body.error?.message ?? `${procedure} failed`);
        return body.json as T;
      };
      const me = await rpc<{ userId: string; spaceId: string }>("me", {});
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Harness bot",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      // The ChatGPT subscription connection the save-time check resolves the
      // bot's effective model against.
      const credential = await handles.prisma.userModelCredential.create({
        data: {
          userId: me.userId,
          provider: "openai-codex",
          label: "ChatGPT",
          secretId: `secret-${randomUUID()}`,
        },
      });
      await handles.prisma.spaceModelPreference.create({
        data: {
          spaceId: me.spaceId,
          userId: me.userId,
          credentialId: credential.id,
          modelId: model.id,
          isDefault: true,
        },
      });
      await handles.prisma.bot.update({
        where: { id: bot.id },
        data: { modelProvider: model.provider, modelId: model.id },
      });

      const saved = await rpc<{ harness: string }>("bots/update", {
        botId: bot.id,
        harness: "codex-native",
      });
      expect(saved.harness).toBe("codex-native");
      const storedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
      expect(storedBot.harnessChoice).toBe("codex-native");
      expect(storedBot.choiceVersion).toBe(1);

      const receipt = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Work with the saved harness",
      });
      const computerId = (
        await handles.prisma.bot.findUniqueOrThrow({
          where: { id: bot.id },
          select: { computerId: true },
        })
      ).computerId;
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: receipt.runId } }),
      ).resolves.toMatchObject({
        harness: "codex-native",
        executionTarget: computerId,
        choiceVersion: 1,
      });

      // An explicit client choice keeps its current behavior.
      const explicit = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "Explicit choice",
        harness: "codex-native",
        executionTarget: computerId!,
      });
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: explicit.runId } }),
      ).resolves.toMatchObject({ choiceVersion: 1 });

      // Saving the default again clears the choice and bumps the version.
      const cleared = await rpc<{ harness: string }>("bots/update", {
        botId: bot.id,
        harness: "default",
      });
      expect(cleared.harness).toBe("default");
      // A send joins an active Run on the thread; settle the earlier ones so this send
      // starts a fresh Run that reads the cleared choice.
      await handles.prisma.run.updateMany({
        where: { botId: bot.id, status: { in: ["queued", "leased", "running"] } },
        data: { status: "completed" },
      });
      const plain = await rpc<{ runId: string }>("threads/send", { botId: bot.id, text: "Plain" });
      await expect(
        handles.prisma.run.findUniqueOrThrow({ where: { id: plain.runId } }),
      ).resolves.toMatchObject({ harness: null, executionTarget: null, choiceVersion: null });
      const clearedBot = await handles.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
      expect(clearedBot.harnessChoice).toBeNull();
      expect(clearedBot.choiceVersion).toBe(2);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
