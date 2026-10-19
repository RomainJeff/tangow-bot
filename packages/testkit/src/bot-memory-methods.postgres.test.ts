import { createBotMemoryClassificationService } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import {
  memoryManagementEnabled,
  runMemoryManagementTool,
} from "../../adapters/src/memory-management-tools.js";
import { prepared, protocol, useBotMemoryFixtures } from "./bot-memory-fixtures.js";
import { memoryDatabaseAvailable } from "./memory-app.js";

const origin = "http://127.0.0.1:5173";

describe.skipIf(!memoryDatabaseAvailable)("bot memory methods", () => {
  const { app, actor, create, disableMethod, method } = useBotMemoryFixtures(
    () => import("../../../apps/api/src/app.ts"),
  );

  it("keeps management disabled until a specific bot is enabled and rechecks revocation", async () => {
    const owner = await actor();
    const configured = await method(owner);
    const source = await create(owner);
    const botId = configured.botId;
    expect(await memoryManagementEnabled(app.handles.prisma, owner, botId)).toBe(false);
    await expect(
      runMemoryManagementTool(
        app.handles.prisma,
        owner,
        botId,
        "memory_read",
        { documentId: source.id },
        "read",
      ),
    ).rejects.toThrow();
    await app.handles.prisma.botSkill.create({
      data: {
        botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        skillKey: "builtin:memory-management",
        enabled: true,
      },
    });
    expect(await memoryManagementEnabled(app.handles.prisma, owner, botId)).toBe(true);
    expect(
      await runMemoryManagementTool(
        app.handles.prisma,
        owner,
        botId,
        "memory_read",
        { documentId: source.id },
        "read",
      ),
    ).toMatchObject({ document: { id: source.id } });
    const other = await method(owner);
    expect(await memoryManagementEnabled(app.handles.prisma, owner, other.botId)).toBe(false);
    const privateSource = await app.library.create(owner, {
      collection: "agent",
      botId: other.botId,
      content: protocol,
    });
    await expect(
      runMemoryManagementTool(
        app.handles.prisma,
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
        app.handles.prisma,
        outsider,
        botId,
        "memory_read",
        { documentId: source.id },
        "read-outsider",
      ),
    ).rejects.toThrow();
    await app.handles.prisma.botSkill.update({
      where: { botId_skillKey: { botId, skillKey: "builtin:memory-management" } },
      data: { enabled: false },
    });
    await expect(
      runMemoryManagementTool(
        app.handles.prisma,
        owner,
        botId,
        "change_memory",
        { action: "withdraw", documentId: source.id, expectedRevision: source.revision },
        "withdraw",
      ),
    ).rejects.toThrow();
    expect((await app.library.get(owner, source.id)).status).toBe("active");
  });

  it("prepares only from current bot instructions and preserves revisions during managed changes", async () => {
    const owner = await actor();
    const configured = await method(owner);
    const botId = configured.botId;
    const instructions = "\n  For this fixture, distinguish a guide from an event record.\n";
    await app.handles.prisma.bot.update({ where: { id: botId }, data: { instructions } });
    await app.handles.prisma.botSkill.create({
      data: {
        botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        skillKey: "builtin:memory-management",
        enabled: true,
      },
    });
    await expect(
      runMemoryManagementTool(
        app.handles.prisma,
        owner,
        botId,
        "prepare_memory_method",
        { expectedInstructions: "Injected policy", expectedVersion: 1, prepared },
        "prepare-invalid",
      ),
    ).rejects.toThrow();
    expect(
      await runMemoryManagementTool(
        app.handles.prisma,
        owner,
        botId,
        "prepare_memory_method",
        { expectedInstructions: instructions, expectedVersion: 1, prepared },
        "prepare",
      ),
    ).toMatchObject({ version: 2, provider: "local" });
    expect(
      await runMemoryManagementTool(
        app.handles.prisma,
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
        app.handles.prisma,
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
        app.handles.prisma,
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
      (await app.library.history(owner, source.id)).some((item) => item.content === source.content),
    ).toBe(true);
  });

  it("runs the shared bot service locally and returns an exact review link without validating", async () => {
    const owner = await actor();
    const configured = await method(owner);
    const source = await create(owner);
    const resolve = vi.fn(async () => {
      throw new Error("A local method must not resolve a decision provider");
    });
    const service = createBotMemoryClassificationService({
      prisma: app.handles.prisma,
      decisionProviders: { resolve },
    });
    await app.handles.prisma.botSkill.create({
      data: {
        botId: configured.botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        skillKey: "builtin:memory-management",
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
    expect(resolve).not.toHaveBeenCalled();
    expect(
      await app.handles.prisma.memoryClassificationFeedback.count({
        where: { documentId: source.id },
      }),
    ).toBe(0);
    expect(await app.library.get(owner, source.id)).toMatchObject({
      revision: source.revision,
      content: source.content,
      qualification: source.qualification,
    });
    const outsider = await actor();
    await expect(
      service.classifyForBot({ actor: outsider, botId: configured.botId, memoryId: source.id }),
    ).rejects.toThrow();
    await disableMethod(configured.botId);
    await expect(
      service.classifyForBot({ actor: owner, botId: configured.botId, memoryId: source.id }),
    ).rejects.toThrow();
  });
});
