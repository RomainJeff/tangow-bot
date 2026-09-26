import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MemoryClassificationToolResult } from "@rakazo/adapter-kit";
import { ComposioEmulator } from "@rakazo/adapters";
import type { MemoryLibraryDocument, MemoryLibrarySummary } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it("prepares, reviews and learns through the chosen bot with exact human approvals", async () => {
    const instructions =
      "Classify the purpose: Guide for reusable procedures, Record for a completed event.";
    const prepared = {
      questions: [
        {
          key: "purpose",
          label: "Purpose",
          instructions,
          options: [
            { key: "guide", label: "Guide", description: "Reusable procedure" },
            { key: "record", label: "Record", description: "Completed event notes" },
          ],
        },
      ],
    };
    const prepareArgs = { expectedInstructions: instructions, expectedVersion: null, prepared };
    let sourceId = "";
    let candidateId = "";
    let suggestion: MemoryClassificationToolResult;
    const reviewArgs = () => ({
      documentId: sourceId,
      expectedRevision: 1,
      classificationId: suggestion.classificationId,
      answers: { purpose: "guide" },
    });
    const noCheck = () => {};
    const lastResult = (request: { messages: Array<{ role: string; content?: unknown }> }) =>
      JSON.parse(String(request.messages.findLast((message) => message.role === "tool")?.content));
    const fixtureKey = "offline-memory-manager-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(request.tools?.map((item) => item.function.name)).toEqual(
              expect.arrayContaining([
                "memory_read",
                "prepare_memory_method",
                "classify_memory",
                "review_memory_classification",
                "change_memory",
              ]),
            );
          },
          response: {
            type: "tool",
            id: "prepare",
            name: "prepare_memory_method",
            arguments: prepareArgs,
          },
        },
        {
          expect: noCheck,
          response: {
            type: "tool",
            id: "prepare-resumed",
            name: "prepare_memory_method",
            arguments: prepareArgs,
          },
        },
        {
          expect(request) {
            expect(lastResult(request)).toMatchObject({ version: 1, provider: "local" });
          },
          response: () => ({
            type: "tool",
            id: "classify",
            name: "classify_memory",
            arguments: { memoryId: sourceId },
          }),
        },
        {
          expect(request) {
            suggestion = lastResult(request);
            expect(suggestion.suggestion.abstained).toBe(true);
          },
          response: () => ({
            type: "tool",
            id: "review",
            name: "review_memory_classification",
            arguments: reviewArgs(),
          }),
        },
        {
          expect: noCheck,
          response: () => ({
            type: "tool",
            id: "review-resumed",
            name: "review_memory_classification",
            arguments: { ...reviewArgs(), answers: { purpose: "record" } },
          }),
        },
        {
          expect(request) {
            expect(lastResult(request)).toHaveProperty("feedbackId");
          },
          response: () => ({
            type: "tool",
            id: "learned",
            name: "classify_memory",
            arguments: { memoryId: candidateId },
          }),
        },
        {
          expect(request) {
            expect(lastResult(request).suggestion).toMatchObject({
              answers: { purpose: "guide" },
              abstained: false,
            });
          },
          response: {
            type: "text",
            text: "The approved correction guided the next classification.",
          },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-memory-manager-"));
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
        encryptionKey: "offline-memory-manager-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `manager-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Manager Fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      await rpc(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
      });
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Memory manager fixture",
        title: "",
        description: "",
        instructions,
        notifyOnFinish: false,
      });
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      await rpc(handles.app, cookie, "agentSkills/setAccess", {
        skillId: "builtin:Memory management",
        bots: [{ botId: bot.id, enabled: true }],
      });
      for (let index = 0; index < 2; index++) {
        const document = await rpc<MemoryLibraryDocument>(
          handles.app,
          cookie,
          "memory/library/create",
          {
            collection: "personal",
            content: "Prepare three open questions before each interview.",
            idempotencyKey: randomUUID(),
          },
        );
        if (index === 0) sourceId = document.id;
        else candidateId = document.id;
      }
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Prepare my criteria and classify the interview protocol.",
      });
      const wait = async (status: string) =>
        expect
          .poll(
            async () =>
              (await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } })).status,
            { timeout: 15000, interval: 100 },
          )
          .toBe(status);
      const approve = async (kind: string) => {
        await wait("waiting_input");
        const effect = await handles.prisma.externalEffect.findFirstOrThrow({
          where: { runId: sent.runId, kind, status: "intended" },
        });
        const card = await handles.prisma.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(card.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "ask",
              approvalEffectId: effect.id,
              actions: [
                { id: "allow", label: "Allow once" },
                { id: "deny", label: "Deny" },
              ],
            }),
          ]),
        );
        if (kind === "prepare_memory_method")
          expect(await handles.prisma.botMemoryMethod.count({ where: { botId: bot.id } })).toBe(0);
        else
          expect(
            await handles.prisma.memoryClassificationFeedback.count({ where: { botId: bot.id } }),
          ).toBe(0);
        await rpc(handles.app, cookie, "threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer: "allow",
        });
      };
      await approve("prepare_memory_method");
      await approve("review_memory_classification");
      await wait("completed");
      model.assertComplete();
      const feedback = await handles.prisma.memoryClassificationFeedback.findMany({
        where: { botId: bot.id },
      });
      expect(feedback).toHaveLength(1);
      expect(feedback[0]!.reviewed).toEqual({ purpose: "guide" });
      expect(
        (
          await rpc<MemoryLibraryDocument>(handles.app, cookie, "memory/library/get", {
            documentId: sourceId,
          })
        ).revision,
      ).toBe(1);
    } finally {
      await stop?.();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);

  it("keeps automatic memory proposed until acceptance and excludes withdrawn memory on the next model call", async () => {
    const marker = "MEMORY-CANARY-INVITATION-739";
    const fixtureKey = "offline-memory-fixture-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(request.tools).toContainEqual(
              expect.objectContaining({ function: expect.objectContaining({ name: "remember" }) }),
            );
          },
          response: {
            type: "tool",
            id: "remember-fixture",
            name: "remember",
            arguments: { content: marker },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("remember-fixture");
            expect(JSON.parse(String(result?.content))).toMatchObject({ ok: true });
          },
          response: { type: "text", text: "A memory proposal is ready." },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).not.toContain(marker);
          },
          response: { type: "text", text: "No accepted memory." },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).not.toContain(marker);
          },
          response: { type: "text", text: "Memory recall paused." },
        },
        {
          expect(request) {
            const system = request.messages.filter((message) => message.role === "system");
            expect(JSON.stringify(system)).not.toContain(marker);
            expect(
              JSON.stringify(request.messages.filter((message) => message.role === "user")),
            ).toContain(marker);
          },
          response: { type: "text", text: "Accepted memory available." },
        },
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).not.toContain(marker);
          },
          response: { type: "text", text: "Withdrawn memory excluded." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-memory-product-"));
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
        encryptionKey: "offline-memory-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `memory-pi-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Memory Pi Fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      await rpc(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
      });
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Memory Pi Fixture",
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
      const turn = async (text: string) => {
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text,
        });
        await expect
          .poll(
            async () =>
              (await handles.prisma.run.findUnique({ where: { id: sent.runId } }))?.status,
            { timeout: 15000, interval: 100 },
          )
          .toBe("completed");
        return sent.runId;
      };
      await turn("Propose a memory for this experiment.");
      const proposals = await rpc<{ items: MemoryLibrarySummary[] }>(
        handles.app,
        cookie,
        "memory/library/list",
        { collection: "agent", botId: bot.id, status: "proposed" },
      );
      const proposedDocuments = await Promise.all(
        proposals.items.map((item) =>
          rpc<MemoryLibraryDocument>(handles.app, cookie, "memory/library/get", {
            documentId: item.id,
          }),
        ),
      );
      const proposal = proposedDocuments.find((item) => item.content.includes(marker));
      expect(proposal).toBeDefined();
      await rpc(handles.app, cookie, "threads/clear", { botId: bot.id });
      await turn("Check accepted experiment memory.");
      const accepted = await rpc<MemoryLibraryDocument>(
        handles.app,
        cookie,
        "memory/library/accept",
        { documentId: proposal!.id, expectedRevision: proposal!.revision },
      );
      const storedBot = await handles.prisma.bot.findUniqueOrThrow({
        where: { id: bot.id },
        select: { spaceId: true },
      });
      await handles.prisma.space.update({
        where: { id: storedBot.spaceId },
        data: { memoryRecallEnabled: false },
      });
      await rpc(handles.app, cookie, "threads/clear", { botId: bot.id });
      await turn("Check experiment memory while recall is paused.");
      await handles.prisma.space.update({
        where: { id: storedBot.spaceId },
        data: { memoryRecallEnabled: true },
      });
      await rpc(handles.app, cookie, "threads/clear", { botId: bot.id });
      const recalledRun = await turn("Check accepted experiment memory again.");
      const run = await handles.prisma.run.findUniqueOrThrow({ where: { id: recalledRun } });
      expect(run.memoryContextManifest).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ documentId: accepted.id, revision: accepted.revision }),
        ]),
      );
      await rpc(handles.app, cookie, "memory/library/withdraw", {
        documentId: accepted.id,
        expectedRevision: accepted.revision,
      });
      await rpc(handles.app, cookie, "threads/clear", { botId: bot.id });
      await turn("Check experiment memory after withdrawal.");
      model.assertComplete();
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 60000);

  it("uses a saved model connection and the real executor to persist a file and completed run", async () => {
    const fixtureKey = "offline-product-fixture-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Save hello to notes/result.txt.");
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                function: expect.objectContaining({ name: "write_file" }),
              }),
            );
          },
          response: {
            type: "tool",
            id: "product-write",
            name: "write_file",
            arguments: { path: "notes/result.txt", content: "hello" },
          },
        },
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("product-write");
            expect(JSON.parse(String(result?.content))).toMatchObject({
              ok: true,
              path: "notes/result.txt",
            });
          },
          response: { type: "text", text: "Saved notes/result.txt." },
        },
      ],
    });
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
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `offline-pi-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Offline fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
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
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Save hello to notes/result.txt.",
      });
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
        .toBe("completed");
      model.assertComplete();
      const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
        botId: bot.id,
        path: "notes/result.txt",
      });
      expect(file.content).toBe("hello");
      const thread = await rpc<{ messages: Array<{ role: string; blocks: unknown[] }> }>(
        handles.app,
        cookie,
        "threads/get",
        { botId: bot.id },
      );
      const messages = JSON.stringify(thread.messages);
      expect(messages).toContain("Saved notes/result.txt.");
      expect(messages).not.toContain(fixtureKey);
      const tools = await handles.prisma.event.findMany({
        where: { botId: bot.id, type: "agent.tool.called" },
        select: { payload: true },
      });
      expect(tools).toHaveLength(1);
      expect(JSON.stringify(tools[0])).toContain("write_file");
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

async function rpc<T>(
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
