import { randomUUID } from "node:crypto";
import type { MemoryClassificationToolResult } from "@rakazo/adapter-kit";
import type { MemoryLibraryDocument, MemoryLibrarySummary } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { latestCard } from "./index.js";
import { memoryDatabaseAvailable, useMemoryApp } from "./memory-app.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

// Pi nudges a plain-text final reply once, so a visible reply is message_user then text.
const reply = (check: ModelEmulatorStep["expect"], text: string): ModelEmulatorStep[] => [
  {
    expect: check,
    response: {
      type: "tool",
      id: randomUUID(),
      name: "message_user",
      arguments: { message: text },
    },
  },
  { expect() {}, response: { type: "text", text } },
];

describe.skipIf(!memoryDatabaseAvailable)("offline Pi memory journey", () => {
  const app = useMemoryApp("pi-memory", () => import("../../../apps/api/src/app.ts"), {
    agentRuntime: "pi",
    encryptionKey: "offline-pi-memory-encryption-key",
  });
  const { rpc, signup } = app;

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
        ...reply((request) => {
          expect(lastResult(request).suggestion).toMatchObject({
            answers: { purpose: "guide" },
            abstained: false,
          });
        }, "The approved correction guided the next classification."),
      ],
    });
    try {
      const member = await signup("Manager Fixture");
      await rpc(member, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
      });
      const bot = await rpc<{ id: string }>(member, "bots/create", {
        name: "Memory manager fixture",
        title: "",
        description: "",
        instructions,
        notifyOnFinish: false,
      });
      await rpc(member, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      await rpc(member, "agentSkills/setAccess", {
        skillId: "builtin:memory-management",
        bots: [{ botId: bot.id, enabled: true }],
      });
      for (let index = 0; index < 2; index++) {
        const document = await rpc<MemoryLibraryDocument>(member, "memory/library/create", {
          collection: "personal",
          content: "Prepare three open questions before each interview.",
          idempotencyKey: randomUUID(),
        });
        if (index === 0) sourceId = document.id;
        else candidateId = document.id;
      }
      const sent = await rpc<{ runId: string }>(member, "threads/send", {
        botId: bot.id,
        text: "Prepare my criteria and classify the interview protocol.",
      });
      const wait = async (status: string) =>
        expect
          .poll(
            async () =>
              (await app.handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } }))
                .status,
            { timeout: 15000, interval: 100 },
          )
          .toBe(status);
      const approve = async (kind: string) => {
        await wait("waiting_input");
        const effect = await app.handles.prisma.externalEffect.findFirstOrThrow({
          where: { runId: sent.runId, kind, status: "intended" },
        });
        const card = await latestCard(app.handles.prisma, sent.runId);
        expect(card.block).toEqual(
          expect.objectContaining({
            kind: "ask",
            approvalEffectId: effect.id,
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }),
        );
        if (kind === "prepare_memory_method")
          expect(await app.handles.prisma.botMemoryMethod.count({ where: { botId: bot.id } })).toBe(
            0,
          );
        else
          expect(
            await app.handles.prisma.memoryClassificationFeedback.count({
              where: { botId: bot.id },
            }),
          ).toBe(0);
        await rpc(member, "threads/answer", {
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
      const feedback = await app.handles.prisma.memoryClassificationFeedback.findMany({
        where: { botId: bot.id },
      });
      expect(feedback).toHaveLength(1);
      expect(feedback[0]!.reviewed).toEqual({ purpose: "guide" });
      expect(
        (
          await rpc<MemoryLibraryDocument>(member, "memory/library/get", {
            documentId: sourceId,
          })
        ).revision,
      ).toBe(1);
    } finally {
      await model.close();
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
        ...reply((request) => {
          const result = request.messages.findLast((message) => message.role === "tool");
          expect(result?.tool_call_id).toBe("remember-fixture");
          expect(JSON.parse(String(result?.content))).toMatchObject({ ok: true });
        }, "A memory proposal is ready."),
        ...reply((request) => {
          expect(JSON.stringify(request.messages)).not.toContain(marker);
        }, "No accepted memory."),
        ...reply((request) => {
          expect(JSON.stringify(request.messages)).not.toContain(marker);
        }, "Memory recall paused."),
        ...reply((request) => {
          const system = request.messages.filter((message) => message.role === "system");
          expect(JSON.stringify(system)).not.toContain(marker);
          expect(
            JSON.stringify(request.messages.filter((message) => message.role === "user")),
          ).toContain(marker);
        }, "Accepted memory available."),
        ...reply((request) => {
          expect(JSON.stringify(request.messages)).not.toContain(marker);
        }, "Withdrawn memory excluded."),
      ],
    });
    try {
      const member = await signup("Memory Pi Fixture");
      await rpc(member, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
      });
      const bot = await rpc<{ id: string }>(member, "bots/create", {
        name: "Memory Pi Fixture",
        title: "",
        description: "",
        instructions: "Complete the task.",
        notifyOnFinish: false,
      });
      await rpc(member, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const turn = async (text: string) => {
        const sent = await rpc<{ runId: string }>(member, "threads/send", {
          botId: bot.id,
          text,
        });
        await expect
          .poll(
            async () =>
              (await app.handles.prisma.run.findUnique({ where: { id: sent.runId } }))?.status,
            { timeout: 15000, interval: 100 },
          )
          .toBe("completed");
        return sent.runId;
      };
      await turn("Propose a memory for this experiment.");
      const proposals = await rpc<{ items: MemoryLibrarySummary[] }>(
        member,
        "memory/library/list",
        { collection: "agent", botId: bot.id, status: "proposed" },
      );
      const proposedDocuments = await Promise.all(
        proposals.items.map((item) =>
          rpc<MemoryLibraryDocument>(member, "memory/library/get", {
            documentId: item.id,
          }),
        ),
      );
      const proposal = proposedDocuments.find((item) => item.content.includes(marker));
      expect(proposal).toBeDefined();
      await rpc(member, "threads/clear", { botId: bot.id });
      await turn("Check accepted experiment memory.");
      const { actor } = member;
      const { library } = app;
      const accepted = await library.accept(actor, proposal!.id, proposal!.revision);
      const storedBot = await app.handles.prisma.bot.findUniqueOrThrow({
        where: { id: bot.id },
        select: { spaceId: true },
      });
      await app.handles.prisma.space.update({
        where: { id: storedBot.spaceId },
        data: { memoryRecallEnabled: false },
      });
      await rpc(member, "threads/clear", { botId: bot.id });
      await turn("Check experiment memory while recall is paused.");
      await app.handles.prisma.space.update({
        where: { id: storedBot.spaceId },
        data: { memoryRecallEnabled: true },
      });
      await rpc(member, "threads/clear", { botId: bot.id });
      const recalledRun = await turn("Check accepted experiment memory again.");
      const run = await app.handles.prisma.run.findUniqueOrThrow({ where: { id: recalledRun } });
      expect(run.memoryContextManifest).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ documentId: accepted.id, revision: accepted.revision }),
        ]),
      );
      await library.withdraw(actor, accepted.id, accepted.revision);
      await rpc(member, "threads/clear", { botId: bot.id });
      await turn("Check experiment memory after withdrawal.");
      model.assertComplete();
    } finally {
      await model.close();
    }
  }, 60000);
});
