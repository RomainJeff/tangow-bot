import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator, createBotMemoryClassificationService } from "@rakazo/adapters";
import type { Actor, MemoryMethodSnapshot, PreparedMemoryMethod } from "@rakazo/contracts";
import type {
  MemoryBotClassificationExample,
  MemoryBotClassificationInput,
  MemoryBotClassifier,
} from "@rakazo/memory";
import { localMemoryBotClassifier, MarkdownMemoryLibrary } from "@rakazo/memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import {
  disableBotMemoryMethod,
  getBotMemoryMethod,
  listBotMemoryMethods,
  updateBotMemoryMethod,
} from "../../../apps/api/src/bot-memory-methods.ts";
import {
  memoryManagementEnabled,
  runMemoryManagementTool,
} from "../../adapters/src/memory-management-tools.js";
import { sessionCookieHeader } from "./index.js";

const available = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const protocol =
  "Prepare three open questions before each interview. Separate observation from interpretation.";
const prepared: PreparedMemoryMethod = {
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

describe.skipIf(!available)("bot memory methods", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let library: MarkdownMemoryLibrary;
  let dataDir: string;
  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-bot-methods-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
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
    });
    library = new MarkdownMemoryLibrary(handles.prisma);
  });
  afterAll(async () => {
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });
  async function actor(): Promise<Actor> {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `feedback-${randomUUID()}@rakazo.test`,
        password: "password12",
        name: "Review Fixture",
      }),
    });
    expect(response.status).toBeLessThan(400);
    const me = await handles.app.request("/rpc/me", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: sessionCookieHeader(response),
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(me.status).toBe(200);
    const current: Actor = (await me.json()).json;
    const space = await handles.app.request("/rpc/spaces/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie: sessionCookieHeader(response),
        "x-rakazo-space-id": current.spaceId,
      },
      body: JSON.stringify({ json: { name: "Feedback fixture space" } }),
    });
    expect(space.status).toBe(200);
    return { ...current, spaceId: (await space.json()).json.id };
  }
  async function join(member: Actor, owner: Actor) {
    const space = await handles.prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
      select: { organizationId: true },
    });
    await handles.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: member.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await handles.prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        spaceId: owner.spaceId,
        userId: member.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    return { ...member, spaceId: owner.spaceId };
  }
  function create(owner: Actor, collection: "personal" | "space" = "personal", content = protocol) {
    return library.create(owner, {
      collection,
      title: "Interview protocol fixture",
      content,
      qualification: { subjects: [] },
      active: true,
      idempotencyKey: randomUUID(),
    });
  }
  const deps = () => ({ prisma: handles.prisma, prepare: async () => prepared });
  async function method(owner: Actor, sharing: "private" | "space" = "private") {
    const bot = await handles.prisma.bot.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Method fixture",
        instructions: "Distinguish reusable guidance from records of particular events.",
        color: "green",
      },
    });
    return updateBotMemoryMethod(deps(), owner, {
      botId: bot.id,
      expectedVersion: null,
      instructions: "Distinguish reusable guidance from records of particular events.",
      provider: "local",
      model: "reviewed-examples",
      allowedCollections: ["personal", "agent", "space"],
      sharing,
    });
  }
  function classify(
    owner: Actor,
    document: { id: string; revision: number },
    method: MemoryMethodSnapshot,
    classifier?: MemoryBotClassifier,
  ) {
    return library.classifyByBot(
      owner,
      {
        botId: method.botId,
        botName: "Method fixture",
        method,
        documentId: document.id,
        expectedRevision: document.revision,
      },
      classifier,
    );
  }
  async function review(
    owner: Actor,
    document: { id: string; revision: number },
    method: MemoryMethodSnapshot,
    answer = "guide",
    shareWithTeam = false,
  ) {
    const run = await classify(owner, document, method);
    const input = {
      classificationId: run.classificationId,
      expectedRevision: document.revision,
      reviewedQuestionKeys: ["purpose"],
      answers: { purpose: answer },
      shareWithTeam,
    };
    return { run, input, result: await library.reviewBotClassification(owner, input) };
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

  it("keeps management disabled until a specific bot is enabled and rechecks revocation", async () => {
    const owner = await actor();
    const configured = await method(owner);
    const source = await create(owner);
    const botId = configured.botId;
    expect(await memoryManagementEnabled(handles.prisma, owner, botId)).toBe(false);
    await expect(
      runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "memory_read",
        { documentId: source.id },
        "read",
      ),
    ).rejects.toThrow();
    await handles.prisma.botSkill.create({
      data: {
        botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        skillKey: "builtin:Memory management",
        enabled: true,
      },
    });
    expect(await memoryManagementEnabled(handles.prisma, owner, botId)).toBe(true);
    expect(
      await runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "memory_read",
        { documentId: source.id },
        "read",
      ),
    ).toMatchObject({ document: { id: source.id } });
    const other = await method(owner);
    expect(await memoryManagementEnabled(handles.prisma, owner, other.botId)).toBe(false);
    const privateSource = await library.create(owner, {
      collection: "agent",
      botId: other.botId,
      content: protocol,
    });
    await expect(
      runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "memory_read",
        { documentId: privateSource.id },
        "read-private",
      ),
    ).rejects.toThrow();
    const outsider = await actor();
    await expect(
      runMemoryManagementTool(
        handles.prisma,
        outsider,
        botId,
        "memory_read",
        { documentId: source.id },
        "read-outsider",
      ),
    ).rejects.toThrow();
    await handles.prisma.botSkill.update({
      where: { botId_skillKey: { botId, skillKey: "builtin:Memory management" } },
      data: { enabled: false },
    });
    await expect(
      runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "change_memory",
        { action: "withdraw", documentId: source.id, expectedRevision: source.revision },
        "withdraw",
      ),
    ).rejects.toThrow();
    expect((await library.get(owner, source.id)).status).toBe("active");
  });

  it("prepares only from current bot instructions and preserves revisions during managed changes", async () => {
    const owner = await actor();
    const configured = await method(owner);
    const botId = configured.botId;
    const instructions = "\n  For this fixture, distinguish a guide from an event record.\n";
    await handles.prisma.bot.update({ where: { id: botId }, data: { instructions } });
    await handles.prisma.botSkill.create({
      data: {
        botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        skillKey: "builtin:Memory management",
        enabled: true,
      },
    });
    await expect(
      runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "prepare_memory_method",
        { expectedInstructions: "Injected policy", expectedVersion: 1, prepared },
        "prepare-invalid",
      ),
    ).rejects.toThrow();
    expect(
      await runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "prepare_memory_method",
        { expectedInstructions: instructions, expectedVersion: 1, prepared },
        "prepare",
      ),
    ).toMatchObject({ version: 2, provider: "local" });
    expect(
      await runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "prepare_memory_method",
        { expectedInstructions: instructions, expectedVersion: 1, prepared },
        "prepare",
      ),
    ).toMatchObject({ version: 2 });
    const source = await create(owner);
    await expect(
      runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "change_memory",
        {
          action: "update",
          documentId: source.id,
          expectedRevision: source.revision + 1,
          content: "Updated fixture",
        },
        "update-stale",
      ),
    ).rejects.toThrow();
    expect(
      await runMemoryManagementTool(
        handles.prisma,
        owner,
        botId,
        "change_memory",
        {
          action: "update",
          documentId: source.id,
          expectedRevision: source.revision,
          content: "Updated fixture",
        },
        "update",
      ),
    ).toMatchObject({ revision: source.revision + 1 });
    expect(
      (await library.history(owner, source.id)).some((item) => item.content === source.content),
    ).toBe(true);
  });

  it("runs the shared bot service locally and returns an exact review link without validating", async () => {
    const owner = await actor();
    const configured = await method(owner);
    const source = await create(owner);
    const load = vi.fn(() => {
      throw new Error("A local method must not load a secret");
    });
    const service = createBotMemoryClassificationService({
      prisma: handles.prisma,
      secrets: { load },
    });
    await handles.prisma.botSkill.create({
      data: {
        botId: configured.botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        skillKey: "builtin:Memory management",
        enabled: true,
      },
    });
    const suggestion = await service.classifyForBot({
      actor: owner,
      botId: configured.botId,
      memoryId: source.id,
    });
    const link = new URL(suggestion.reviewPath, origin);
    expect(link.pathname).toBe(`/app/${configured.botId}`);
    expect(suggestion).toMatchObject({ documentId: source.id, revision: source.revision });
    expect(suggestion.questions[0]?.key).toBe("purpose");
    expect(load).not.toHaveBeenCalled();
    expect(
      await handles.prisma.memoryClassificationFeedback.count({ where: { documentId: source.id } }),
    ).toBe(0);
    expect(await library.get(owner, source.id)).toMatchObject({
      revision: source.revision,
      content: source.content,
      qualification: source.qualification,
    });
    expect(
      await library.getBotClassificationRun(owner, {
        classificationId: suggestion.classificationId,
        documentId: source.id,
      }),
    ).toMatchObject({ bot: { id: configured.botId }, method: { version: 1 } });
    const outsider = await actor();
    await expect(
      service.classifyForBot({ actor: outsider, botId: configured.botId, memoryId: source.id }),
    ).rejects.toThrow();
    await disableBotMemoryMethod(handles.prisma, owner, configured.botId, 1);
    await expect(
      service.classifyForBot({ actor: owner, botId: configured.botId, memoryId: source.id }),
    ).rejects.toThrow();
  });

  it("invalidates prepared criteria and pending feedback when ordinary Instructions change", async () => {
    const owner = await actor();
    const configured = await method(owner);
    const source = await create(owner);
    const run = await classify(owner, source, configured);
    await handles.prisma.bot.update({
      where: { id: configured.botId },
      data: { instructions: "A revised classification policy" },
    });
    await expect(classify(owner, source, configured)).rejects.toThrow();
    await expect(
      library.reviewBotClassification(owner, {
        classificationId: run.classificationId,
        expectedRevision: source.revision,
        reviewedQuestionKeys: ["purpose"],
        answers: { purpose: "guide" },
      }),
    ).rejects.toThrow();
    expect(
      await handles.prisma.memoryClassificationFeedback.count({
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
    const before = await library.get(owner, source.id);
    const firstReview = await review(owner, source, first);
    const agentMemory = await library.create(owner, {
      collection: "agent",
      botId: second.botId,
      content: protocol,
      qualification: { subjects: [] },
      active: true,
      idempotencyKey: randomUUID(),
    });
    await expect(classify(owner, agentMemory, first)).rejects.toThrow();
    expect((await classify(owner, agentMemory, second)).bot.id).toBe(second.botId);
    expect(await library.get(owner, source.id)).toMatchObject({
      revision: before.revision,
      status: before.status,
      qualification: before.qualification,
      content: before.content,
    });
    expect(await library.reviewBotClassification(owner, firstReview.input)).toEqual(
      firstReview.result,
    );
    await expect(
      library.reviewBotClassification(owner, {
        ...firstReview.input,
        answers: { purpose: "record" },
      }),
    ).rejects.toThrow();
    expect((await examples(owner, next, first)).run.suggestion.answers).toEqual({
      purpose: "guide",
    });
    expect((await examples(owner, next, second)).received).toEqual([]);
    await review(owner, source, second, "record");
    const annotations = await library.memoryAnnotations(owner, source.id);
    expect(annotations).toHaveLength(2);
    expect(new Set(annotations.map((item) => item.bot.id))).toEqual(
      new Set([first.botId, second.botId]),
    );
    expect(new Set(annotations.map((item) => item.answers.purpose))).toEqual(
      new Set(["guide", "record"]),
    );
    await library.revokeClassificationFeedback(owner, firstReview.result.feedbackId);
    expect((await examples(owner, next, first)).received).toEqual([]);
    expect(
      (await library.memoryAnnotations(owner, source.id)).find(
        (item) => item.id === firstReview.result.feedbackId,
      )?.revokedAt,
    ).not.toBeNull();
    await handles.prisma.bot.delete({ where: { id: second.botId } });
    expect(
      (await library.memoryAnnotations(owner, source.id)).find(
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
    const next = await updateBotMemoryMethod(deps(), owner, {
      ...original,
      botId: original.botId,
      expectedVersion: original.version,
      instructions: "Updated definitions: distinguish reusable guidance from event records.",
    });
    await handles.prisma.bot.update({
      where: { id: next.botId },
      data: { instructions: next.instructions },
    });
    expect(next.version).toBe(2);
    expect((await examples(owner, candidate, next)).received).toEqual([]);
    await expect(
      library.reviewBotClassification(owner, {
        classificationId: pending.classificationId,
        expectedRevision: candidate.revision,
        reviewedQuestionKeys: ["purpose"],
        answers: { purpose: "guide" },
      }),
    ).rejects.toThrow();
    expect((await library.memoryAnnotations(owner, source.id))[0]?.method.version).toBe(1);
    await disableBotMemoryMethod(handles.prisma, owner, next.botId, next.version);
    expect(await getBotMemoryMethod(deps(), owner, next.botId)).toMatchObject({
      method: null,
      currentVersion: 2,
    });
    expect(await listBotMemoryMethods(deps(), owner)).toEqual([]);
    await expect(classify(owner, candidate, next)).rejects.toThrow();
    const enabled = await updateBotMemoryMethod(deps(), owner, { ...next, expectedVersion: 2 });
    expect(enabled.version).toBe(3);
    expect((await examples(owner, candidate, enabled)).received).toEqual([]);
  });

  it("shares the capability separately from corrections and forbids private or cross-space access", async () => {
    const owner = await actor();
    const outsider = await actor();
    const member = await join(await actor(), owner);
    const privateMethod = await method(owner);
    const sharedMethod = await method(owner, "space");
    const source = await create(owner, "space");
    const candidate = await create(owner, "space");
    const personal = await create(owner);
    expect((await listBotMemoryMethods(deps(), member)).map((entry) => entry.method.id)).toEqual([
      sharedMethod.id,
    ]);
    await expect(classify(member, candidate, privateMethod)).rejects.toThrow();
    await expect(classify(member, personal, sharedMethod)).rejects.toThrow();
    await expect(classify(outsider, candidate, sharedMethod)).rejects.toThrow();
    await expect(
      updateBotMemoryMethod(deps(), member, { ...sharedMethod, expectedVersion: 1 }),
    ).rejects.toThrow();
    await review(owner, source, sharedMethod);
    expect((await examples(member, candidate, sharedMethod)).received).toEqual([]);
    expect(await library.memoryAnnotations(member, source.id)).toEqual([]);
    await review(owner, source, sharedMethod, "guide", true);
    expect((await examples(member, candidate, sharedMethod)).received).toHaveLength(1);
    expect(await library.memoryAnnotations(member, source.id)).toHaveLength(1);
    const memberReview = await review(member, candidate, sharedMethod, "guide", false);
    expect(memberReview.result.feedbackId).toBeTruthy();
    expect((await library.get(member, candidate.id)).canEdit).toBe(false);
    expect(await library.memoryAnnotations(owner, candidate.id)).toEqual([]);
    await handles.prisma.spaceMember.delete({
      where: { spaceId_userId: { spaceId: owner.spaceId, userId: owner.userId } },
    });
    expect((await examples(member, candidate, sharedMethod)).received).toEqual([]);
  });

  it("rejects obsolete sources, invalid answers and feedback revoked during inference", async () => {
    const owner = await actor();
    const current = await method(owner);
    const source = await create(owner);
    const candidate = await create(owner);
    const reviewed = await review(owner, source, current);
    const run = await classify(owner, candidate, current);
    await expect(
      library.reviewBotClassification(owner, {
        classificationId: run.classificationId,
        expectedRevision: candidate.revision,
        reviewedQuestionKeys: ["purpose"],
        answers: { purpose: "activate_all_memories" },
      }),
    ).rejects.toThrow();
    const countBefore = await handles.prisma.memoryClassificationRun.count();
    await expect(
      classify(owner, candidate, current, async (input) => {
        await library.revokeClassificationFeedback(owner, reviewed.result.feedbackId);
        return localMemoryBotClassifier(input);
      }),
    ).rejects.toThrow();
    expect(await handles.prisma.memoryClassificationRun.count()).toBe(countBefore);
    const changed = await library.update(owner, {
      documentId: candidate.id,
      expectedRevision: candidate.revision,
      content: "This protocol is now retired.",
    });
    await expect(
      library.reviewBotClassification(owner, {
        classificationId: run.classificationId,
        expectedRevision: changed.revision,
        reviewedQuestionKeys: ["purpose"],
        answers: { purpose: "guide" },
      }),
    ).rejects.toThrow();
    expect(await library.memoryAnnotations(owner, candidate.id)).toEqual([]);
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
    const countBefore = await handles.prisma.memoryClassificationRun.count();

    await expect(
      classify(owner, candidate, current, async (input) => {
        const example = input.examples?.[0];
        expect(example?.neighbors).toContainEqual({
          content: longNeighbor.content.slice(0, 600),
        });
        expect(example?.neighbors[0]?.content.length).toBe(600);
        await library.revokeClassificationFeedback(owner, reviewed.result.feedbackId);
        return localMemoryBotClassifier(input);
      }),
    ).rejects.toThrow();
    expect(await handles.prisma.memoryClassificationRun.count()).toBe(countBefore);
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
    await library.revokeClassificationFeedback(owner, latest.result.feedbackId);
    expect((await examples(owner, candidate, current)).received).toEqual([]);
  });

  it("rejects malformed preparation and stale saves without touching the current method", async () => {
    const owner = await actor();
    const current = await method(owner);
    const input = { ...current, expectedVersion: current.version };
    await expect(
      updateBotMemoryMethod(
        { prisma: handles.prisma, prepare: async () => ({ questions: [] }) },
        owner,
        input,
      ),
    ).rejects.toThrow();
    expect((await getBotMemoryMethod(deps(), owner, current.botId)).method?.id).toBe(current.id);
    let calls = 0;
    await expect(
      updateBotMemoryMethod(
        {
          prisma: handles.prisma,
          prepare: async () => {
            calls++;
            return prepared;
          },
        },
        owner,
        { ...input, expectedVersion: null },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("reads the exact persisted run without inference, hides it from another user, and closes it after review", async () => {
    const owner = await actor();
    const other = await actor();
    const current = await method(owner);
    const candidate = await create(owner);
    const classifier = vi.fn(async (input: MemoryBotClassificationInput) =>
      localMemoryBotClassifier(input),
    );
    const run = await classify(owner, candidate, current, classifier);

    await expect(
      library.getBotClassificationRun(owner, {
        classificationId: run.classificationId,
        documentId: candidate.id,
      }),
    ).resolves.toEqual(run);
    expect(classifier).toHaveBeenCalledTimes(1);
    await expect(
      library.getBotClassificationRun(other, {
        classificationId: run.classificationId,
        documentId: candidate.id,
      }),
    ).rejects.toThrow();
    await expect(
      library.getBotClassificationRun(owner, {
        classificationId: run.classificationId,
        documentId: "another-document",
      }),
    ).rejects.toThrow();

    await library.reviewBotClassification(owner, {
      classificationId: run.classificationId,
      expectedRevision: candidate.revision,
      reviewedQuestionKeys: ["purpose"],
      answers: { purpose: "guide" },
    });
    await expect(
      library.getBotClassificationRun(owner, {
        classificationId: run.classificationId,
        documentId: candidate.id,
      }),
    ).resolves.toBeNull();
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it("rejects an exact run after its source revision or bot method becomes stale", async () => {
    const owner = await actor();
    const current = await method(owner);
    const candidate = await create(owner);
    const run = await classify(owner, candidate, current);
    const changed = await library.update(owner, {
      documentId: candidate.id,
      expectedRevision: candidate.revision,
      content: `${protocol} Updated after classification.`,
    });
    await expect(
      library.getBotClassificationRun(owner, {
        classificationId: run.classificationId,
        documentId: candidate.id,
      }),
    ).rejects.toThrow();
    expect(changed.revision).toBeGreaterThan(candidate.revision);

    const nextCandidate = await create(owner);
    const nextRun = await classify(owner, nextCandidate, current);
    await disableBotMemoryMethod(handles.prisma, owner, current.botId, current.version);
    await expect(
      library.getBotClassificationRun(owner, {
        classificationId: nextRun.classificationId,
        documentId: nextCandidate.id,
      }),
    ).rejects.toThrow();
  });

  it("keeps a historical run without a bot method as stored history without using the legacy writer", async () => {
    const owner = await actor();
    const candidate = await create(owner);
    const storedDocument = await handles.prisma.memoryDocument.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { collectionId: true, accessVersion: true },
    });
    const legacy = await handles.prisma.memoryClassificationRun.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        documentId: candidate.id,
        collectionId: storedDocument.collectionId,
        revision: candidate.revision,
        accessVersion: storedDocument.accessVersion,
        sourceDigest: "legacy-run-digest",
        candidate: { id: candidate.id, revision: candidate.revision, content: candidate.content },
        neighbors: [],
        prediction: {},
        examples: [],
        methodId: null,
        methodVersion: null,
      },
      select: { id: true },
    });

    await expect(
      library.getBotClassificationRun(owner, {
        classificationId: legacy.id,
        documentId: candidate.id,
      }),
    ).rejects.toThrow();
    expect(
      await handles.prisma.memoryClassificationRun.findUnique({
        where: { id: legacy.id },
        select: { id: true, methodId: true, methodVersion: true },
      }),
    ).toEqual({ id: legacy.id, methodId: null, methodVersion: null });
  });
});
