import { randomUUID } from "node:crypto";
import { localMemoryBotClassifier } from "@rakazo/memory";
import { describe, expect, it } from "vitest";
import { protocol, useBotMemoryFixtures } from "./bot-memory-fixtures.js";
import { memoryDatabaseAvailable } from "./memory-app.js";

describe.skipIf(!memoryDatabaseAvailable)("bot memory classification feedback", () => {
  const {
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
  } = useBotMemoryFixtures(() => import("../../../apps/api/src/app.ts"));

  it("invalidates prepared criteria and pending feedback when ordinary Instructions change", async () => {
    const owner = await actor();
    const configured = await method(owner);
    const source = await create(owner);
    const run = await classify(owner, source, configured);
    await app.handles.prisma.bot.update({
      where: { id: configured.botId },
      data: { instructions: "A revised classification policy" },
    });
    await expect(classify(owner, source, configured)).rejects.toThrow();
    await expect(
      app.library.reviewBotClassification(owner, {
        classificationId: run.classificationId,
        expectedRevision: source.revision,
        reviewedQuestionKeys: ["purpose"],
        answers: { purpose: "guide" },
      }),
    ).rejects.toThrow();
    expect(
      await app.handles.prisma.memoryClassificationFeedback.count({
        where: { runId: run.classificationId },
      }),
    ).toBe(0);
  });

  it("keeps annotations independent from the memory and other bots, with atomic replay and revocation", async () => {
    const owner = await actor();
    const first = await method(owner);
    const second = await method(owner);
    const source = await create(owner);
    const next = await create(owner);
    const before = await app.library.get(owner, source.id);
    const firstReview = await review(owner, source, first);
    const agentMemory = await app.library.create(owner, {
      collection: "agent",
      botId: second.botId,
      content: protocol,
      qualification: { subjects: [] },
      active: true,
      idempotencyKey: randomUUID(),
    });
    await expect(classify(owner, agentMemory, first)).rejects.toThrow();
    expect((await classify(owner, agentMemory, second)).bot.id).toBe(second.botId);
    expect(await app.library.get(owner, source.id)).toMatchObject({
      revision: before.revision,
      status: before.status,
      qualification: before.qualification,
      content: before.content,
    });
    expect(await app.library.reviewBotClassification(owner, firstReview.input)).toEqual(
      firstReview.result,
    );
    await expect(
      app.library.reviewBotClassification(owner, {
        ...firstReview.input,
        answers: { purpose: "record" },
      }),
    ).rejects.toThrow();
    expect((await examples(owner, next, first)).run.suggestion.answers).toEqual({
      purpose: "guide",
    });
    expect((await examples(owner, next, second)).received).toEqual([]);
    await review(owner, source, second, "record");
    const annotations = await app.library.memoryAnnotations(owner, source.id);
    expect(annotations).toHaveLength(2);
    expect(new Set(annotations.map((item) => item.bot.id))).toEqual(
      new Set([first.botId, second.botId]),
    );
    expect(new Set(annotations.map((item) => item.answers.purpose))).toEqual(
      new Set(["guide", "record"]),
    );
    await app.library.revokeClassificationFeedback(owner, firstReview.result.feedbackId);
    expect((await examples(owner, next, first)).received).toEqual([]);
    expect(
      (await app.library.memoryAnnotations(owner, source.id)).find(
        (item) => item.id === firstReview.result.feedbackId,
      )?.revokedAt,
    ).not.toBeNull();
    await app.handles.prisma.bot.delete({ where: { id: second.botId } });
    expect(
      (await app.library.memoryAnnotations(owner, source.id)).find(
        (item) => item.bot.id === second.botId,
      ),
    ).toMatchObject({
      bot: { name: "Method fixture" },
      method: { version: 1 },
      answers: { purpose: "record" },
    });
  });

  it("versions methods, blocks stale runs and re-enables after disable without reviving old feedback", async () => {
    const owner = await actor();
    const original = await method(owner);
    const source = await create(owner);
    const candidate = await create(owner);
    await review(owner, source, original);
    const pending = await classify(owner, candidate, original);
    const next = await saveMethod(
      original.botId,
      "Updated definitions: distinguish reusable guidance from event records.",
    );
    await app.handles.prisma.bot.update({
      where: { id: next.botId },
      data: { instructions: next.instructions },
    });
    expect(next.version).toBe(2);
    expect((await examples(owner, candidate, next)).received).toEqual([]);
    await expect(
      app.library.reviewBotClassification(owner, {
        classificationId: pending.classificationId,
        expectedRevision: candidate.revision,
        reviewedQuestionKeys: ["purpose"],
        answers: { purpose: "guide" },
      }),
    ).rejects.toThrow();
    expect((await app.library.memoryAnnotations(owner, source.id))[0]?.method.version).toBe(1);
    await disableMethod(next.botId);
    await expect(classify(owner, candidate, next)).rejects.toThrow();
    const enabled = await saveMethod(next.botId, next.instructions);
    expect(enabled.version).toBe(3);
    expect((await examples(owner, candidate, enabled)).received).toEqual([]);
  });

  it("keeps a bot method and its corrections private to the bot owner", async () => {
    const owner = await actor();
    const outsider = await actor();
    const member = await join(await actor(), owner);
    const configured = await method(owner);
    const source = await create(owner, "space");
    const candidate = await create(owner, "space");
    await expect(classify(member, candidate, configured)).rejects.toThrow();
    await expect(classify(outsider, candidate, configured)).rejects.toThrow();
    await review(owner, source, configured);
    expect(await app.library.memoryAnnotations(member, source.id)).toEqual([]);
    expect(await app.library.memoryAnnotations(owner, source.id)).toHaveLength(1);
  });

  it("rejects obsolete sources, invalid answers and feedback revoked during inference", async () => {
    const owner = await actor();
    const current = await method(owner);
    const source = await create(owner);
    const candidate = await create(owner);
    const reviewed = await review(owner, source, current);
    const run = await classify(owner, candidate, current);
    await expect(
      app.library.reviewBotClassification(owner, {
        classificationId: run.classificationId,
        expectedRevision: candidate.revision,
        reviewedQuestionKeys: ["purpose"],
        answers: { purpose: "activate_all_memories" },
      }),
    ).rejects.toThrow();
    const countBefore = await app.handles.prisma.memoryClassificationRun.count();
    await expect(
      classify(owner, candidate, current, async (input) => {
        await app.library.revokeClassificationFeedback(owner, reviewed.result.feedbackId);
        return localMemoryBotClassifier(input);
      }),
    ).rejects.toThrow();
    expect(await app.handles.prisma.memoryClassificationRun.count()).toBe(countBefore);
    const changed = await app.library.update(owner, {
      documentId: candidate.id,
      expectedRevision: candidate.revision,
      content: "This protocol is now retired.",
    });
    await expect(
      app.library.reviewBotClassification(owner, {
        classificationId: run.classificationId,
        expectedRevision: changed.revision,
        reviewedQuestionKeys: ["purpose"],
        answers: { purpose: "guide" },
      }),
    ).rejects.toThrow();
    expect(await app.library.memoryAnnotations(owner, candidate.id)).toEqual([]);
  });

  it("revalidates provenance when a reviewed example contains a neighbor truncated for inference", async () => {
    const owner = await actor();
    const current = await method(owner);
    const source = await create(owner);
    const longNeighbor = await create(
      owner,
      "personal",
      `${protocol} ${"interview context ".repeat(100)}`,
    );
    const reviewed = await review(owner, source, current);
    const candidate = await create(owner);
    const countBefore = await app.handles.prisma.memoryClassificationRun.count();

    await expect(
      classify(owner, candidate, current, async (input) => {
        const example = input.examples?.[0];
        expect(example?.neighbors).toContainEqual({
          content: longNeighbor.content.slice(0, 600),
        });
        expect(example?.neighbors[0]?.content.length).toBe(600);
        await app.library.revokeClassificationFeedback(owner, reviewed.result.feedbackId);
        return localMemoryBotClassifier(input);
      }),
    ).rejects.toThrow();
    expect(await app.handles.prisma.memoryClassificationRun.count()).toBe(countBefore);
  });

  it("does not resurrect an older correction after a later correction is revoked", async () => {
    const owner = await actor();
    const current = await method(owner);
    const source = await create(owner);
    const candidate = await create(owner);
    await review(owner, source, current, "guide");
    const latest = await review(owner, source, current, "record");
    expect((await examples(owner, candidate, current)).run.suggestion.answers.purpose).toBe(
      "record",
    );
    await app.library.revokeClassificationFeedback(owner, latest.result.feedbackId);
    expect((await examples(owner, candidate, current)).received).toEqual([]);
  });
});
