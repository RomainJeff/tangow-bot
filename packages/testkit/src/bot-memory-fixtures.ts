import { randomUUID } from "node:crypto";
import type { Actor, MemoryMethodSnapshot, PreparedMemoryMethod } from "@rakazo/contracts";
import type { MemoryBotClassificationExample, MemoryBotClassifier } from "@rakazo/memory";
import { localMemoryBotClassifier } from "@rakazo/memory";
import { useMemoryApp } from "./memory-app.js";

export const protocol =
  "Prepare three open questions before each interview. Separate observation from interpretation.";
export const prepared: PreparedMemoryMethod = {
  questions: [
    {
      key: "purpose",
      label: "Purpose",
      instructions: "Classify the purpose of this document, not the topic it mentions.",
      options: [
        {
          key: "guide",
          label: "Reusable guide",
          description: "A procedure for future interviews.",
        },
        {
          key: "record",
          label: "Event record",
          description: "Notes from a particular completed interview.",
        },
      ],
    },
  ],
};

/** A memory app with bots that carry a prepared method, and helpers to classify and review. */
export function useBotMemoryFixtures(loadApp: Parameters<typeof useMemoryApp>[1]) {
  const app = useMemoryApp("bot-methods", loadApp);
  /** A new person, acting in a Space of their own. */
  async function actor(): Promise<Actor> {
    const member = await app.signup("Review Fixture");
    const space = await app.rpc<{ id: string }>(member, "spaces/create", {
      name: "Feedback fixture space",
    });
    return { ...member.actor, spaceId: space.id };
  }
  async function join(member: Actor, owner: Actor) {
    await app.join(member.userId, owner.spaceId);
    return { ...member, spaceId: owner.spaceId };
  }
  function create(owner: Actor, collection: "personal" | "space" = "personal", content = protocol) {
    return app.library.create(owner, {
      collection,
      title: "Interview protocol fixture",
      content,
      qualification: { subjects: [] },
      active: true,
      idempotencyKey: randomUUID(),
    });
  }
  /** Saves the next method version the way `prepare_memory_method` does, including re-enabling. */
  async function saveMethod(botId: string, instructions: string): Promise<MemoryMethodSnapshot> {
    const current = await app.handles.prisma.botMemoryMethod.findFirst({
      where: { botId },
      orderBy: { version: "desc" },
    });
    const row = await app.handles.prisma.botMemoryMethod.create({
      data: {
        botId,
        version: (current?.version ?? 0) + 1,
        instructions,
        prepared,
        provider: "local",
        model: "reviewed-examples",
      },
    });
    await app.handles.prisma.bot.update({
      where: { id: botId },
      data: { memoryMethodDisabledAt: null },
    });
    return {
      id: row.id,
      botId,
      version: row.version,
      instructions,
      prepared,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt.toISOString(),
    };
  }
  async function disableMethod(botId: string) {
    await app.handles.prisma.bot.update({
      where: { id: botId },
      data: { memoryMethodDisabledAt: new Date() },
    });
  }
  async function method(owner: Actor) {
    const instructions = "Distinguish reusable guidance from records of particular events.";
    const bot = await app.handles.prisma.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Method fixture",
        instructions,
        color: "green",
      },
    });
    return saveMethod(bot.id, instructions);
  }
  function classify(
    owner: Actor,
    document: { id: string; revision: number },
    method: MemoryMethodSnapshot,
    classifier?: MemoryBotClassifier,
  ) {
    return app.library
      .forBot(method.botId)
      .classify(
        owner,
        { documentId: document.id, expectedRevision: document.revision },
        async () => classifier ?? localMemoryBotClassifier,
      );
  }
  async function review(
    owner: Actor,
    document: { id: string; revision: number },
    method: MemoryMethodSnapshot,
    answer = "guide",
  ) {
    const run = await classify(owner, document, method);
    const input = {
      classificationId: run.classificationId,
      expectedRevision: document.revision,
      reviewedQuestionKeys: ["purpose"],
      answers: { purpose: answer },
    };
    return { run, input, result: await app.library.reviewBotClassification(owner, input) };
  }
  async function examples(
    owner: Actor,
    document: { id: string; revision: number },
    method: MemoryMethodSnapshot,
  ) {
    let received: MemoryBotClassificationExample[] = [];
    const run = await classify(owner, document, method, async (input) => {
      received = input.examples ?? [];
      return localMemoryBotClassifier(input);
    });
    return { received, run };
  }
  return {
    app,
    actor,
    join,
    create,
    saveMethod,
    disableMethod,
    method,
    classify,
    review,
    examples,
  };
}
