import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInMemorySkillLock } from "@rakazo/adapters";
import { bundleGuest } from "@rakazo/agent-run-worker/bundle";
import { buildSkillMd } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { createAgentSkillsService } from "../../../apps/api/src/agent-skills.js";
import { indexWorkerSkills } from "../../adapters/src/worker-skills.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const system = (request: ModelEmulatorRequest) =>
  String(request.messages.find((message) => message.role === "system")?.content);
const result = (request: ModelEmulatorRequest) =>
  String(request.messages.findLast((message) => message.role === "tool")?.content);
function location(request: ModelEmulatorRequest, name: string) {
  const block = system(request)
    .split("<skill>")
    .find((block) => block.includes(`<name>${name}</name>`));
  const value = block?.match(/<location>(.*?)<\/location>/)?.[1];
  expect(value).toBeDefined();
  return value!;
}
const finishing: ModelEmulatorStep[] = [
  {
    expect() {},
    response: { type: "tool", id: "say", name: "message_user", arguments: { message: "Done." } },
  },
  {
    expect() {},
    response: {
      type: "text",
      text: JSON.stringify({ version: 1, results: ["Used skills"], references: [] }),
    },
  },
];

it.each(["memory", "child"] as const)(
  "loads volume skills through Pi, records native usage and indexes a new skill for the next run, %s",
  async (mode) => {
    const dir = await mkdtemp(path.join(tmpdir(), "worker-skills-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const guestEntry =
      mode === "child" ? await bundleGuest(path.join(dir, "guest.mjs")) : undefined;
    const run = await startWorkerRun({
      databaseUrl: process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined,
      mode,
      guestEntry,
      steps: [
        {
          expect(request) {
            const prompt = system(request);
            expect(prompt).toContain("<available_skills>");
            expect(prompt).toContain("<name>Interrogate</name>");
            expect(prompt).toContain("<name>bot-guide</name>");
            expect(prompt).toContain("<name>shared-guide</name>");
            expect(prompt).not.toContain("Available Claude Agent Skills");
            const names = request.tools?.map((tool) => tool.function.name);
            expect(names).toContain("read");
            expect(names).toContain("bash");
            for (const name of [
              "skill_read",
              "skill_search",
              "skill_create",
              "skill_update",
              "skill_delete",
            ])
              expect(names).not.toContain(name);
          },
          response: (request) => ({
            type: "tool",
            id: "use",
            name: "read",
            arguments: { path: location(request, "bot-guide") },
          }),
        },
        {
          expect(request) {
            expect(result(request)).toContain("Run the fixture script");
          },
          response: {
            type: "tool",
            id: "script",
            name: "bash",
            arguments: { command: "bash skills/bot-guide/scripts/run.sh" },
          },
        },
        {
          expect(request) {
            expect(result(request)).toContain("skill script ran");
          },
          response: {
            type: "tool",
            id: "create",
            name: "write",
            arguments: {
              path: "skills/new-guide/SKILL.md",
              content: buildSkillMd({
                name: "new-guide",
                description: "Use on the next run",
                body: "Remember this procedure.",
              }),
            },
          },
        },
        ...finishing,
        {
          expect(request) {
            expect(system(request)).toContain("<name>new-guide</name>");
          },
          response: (request) => ({
            type: "tool",
            id: "next",
            name: "read",
            arguments: { path: location(request, "new-guide") },
          }),
        },
        ...finishing,
      ],
    });
    cleanups.push(() => run.close());
    const privateRoot = run.provider.volumePath("bot_private");
    const sharedRoot = run.provider.volumePath("space_shared");
    const seed = async (root: string, dirName: string, name: string, body: string) => {
      await mkdir(path.join(root, "skills", dirName), { recursive: true });
      await writeFile(
        path.join(root, "skills", dirName, "SKILL.md"),
        buildSkillMd({ name, description: `Use ${name}`, body }),
      );
    };
    await seed(privateRoot, "bot-guide", "bot-guide", "Run the fixture script.");
    await mkdir(path.join(privateRoot, "skills", "bot-guide", "scripts"));
    await writeFile(
      path.join(privateRoot, "skills", "bot-guide", "scripts", "run.sh"),
      "echo 'skill script ran'\n",
    );
    await seed(sharedRoot, "shared-guide", "shared-guide", "Shared procedure.");
    await seed(sharedRoot, "collision", "bot-guide", "Must lose to the bot's skill.");
    await seed(privateRoot, "managed-collision", "Interrogate", "Must lose to the managed skill.");
    await seed(privateRoot, "unsafe", "unsafe", "The script holds a secret.");
    await mkdir(path.join(privateRoot, "skills", "unsafe", "scripts"));
    // The fixture's model key is synthetic and known to the controller's secret scanner.
    await writeFile(
      path.join(privateRoot, "skills", "unsafe", "scripts", "run.sh"),
      "echo worker-fixture-model-key\n",
    );
    await run.prisma.skillSetting.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        skillKey: "builtin:Interrogate",
        availability: "disabled",
      },
    });
    const runId = await run.send("Follow bot-guide and write a new skill.");
    await run.continueRun(runId);
    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, error: true },
      }),
    ).toEqual({ status: "completed", error: null });
    const indexed = await run.prisma.volumeSkill.findMany({
      where: { botId: run.bot.id },
      orderBy: { name: "asc" },
    });
    expect(indexed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bot-guide",
          source: "bot",
          contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({ name: "shared-guide", source: "shared" }),
        expect.objectContaining({ name: "new-guide", source: "bot" }),
      ]),
    );
    expect(indexed.some((skill) => skill.name === "unsafe")).toBe(false);
    expect(
      await readFile(path.join(privateRoot, "skills", "unsafe", "scripts", "run.sh"), "utf8"),
    ).toBe("echo worker-fixture-model-key\n");
    const usage = await run.prisma.event.findMany({ where: { runId, type: "agent.skill.used" } });
    expect(usage.map((event) => event.payload)).toContainEqual({ name: "bot-guide", via: "read" });
    const collisions = await run.prisma.event.findMany({
      where: { runId, type: "agent.skill.collision" },
    });
    expect(collisions.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        { name: "Interrogate", kept: "managed", ignored: "bot" },
        { name: "bot-guide", kept: "bot", ignored: "shared" },
      ]),
    );
    const api = createAgentSkillsService(run.prisma, dir, createInMemorySkillLock());
    const actor = {
      spaceId: run.spaceId,
      userId: run.userId,
      organizationId: "org-worker",
      role: "owner",
    };
    const listed = await api.list(actor, { botId: run.bot.id });
    expect(listed).toContainEqual(
      expect.objectContaining({ name: "new-guide", source: "bot", visibleBotIds: [run.bot.id] }),
    );
    const entry = listed.find((skill) => skill.name === "new-guide")!;
    expect(await api.get(actor, { skillId: entry.id })).toMatchObject({
      content: expect.stringContaining("Remember this procedure"),
    });
    await expect(
      api.setAccess(actor, { skillId: entry.id, availability: "disabled" }),
    ).rejects.toThrow();
    const sibling = await run.prisma.bot.create({
      data: { spaceId: run.spaceId, userId: run.userId, name: "Sibling", color: "#000000" },
    });
    const siblingList = await api.list(actor, { botId: sibling.id });
    expect(siblingList.some((skill) => skill.name === "new-guide")).toBe(false);
    expect(siblingList.some((skill) => skill.name === "shared-guide")).toBe(true);
    const shared = indexed.find((skill) => skill.name === "shared-guide")!;
    const { id: _id, createdAt: _created, updatedAt: _updated, ...snapshot } = shared;
    await run.prisma.volumeSkill.create({ data: { ...snapshot, botId: sibling.id } });
    await rm(path.join(sharedRoot, "skills", "shared-guide"), { recursive: true });
    await indexWorkerSkills(
      run.prisma,
      { spaceId: run.spaceId, userId: run.userId, botId: run.bot.id, runId, fence: 1 },
      [],
      ["managed", "bot", "shared"],
      [],
    );
    // Completed runs cannot replace a live index, even with an empty report.
    expect(await run.prisma.volumeSkill.count({ where: { botId: run.bot.id } })).toBe(
      indexed.length,
    );
    const next = await run.send("Use the new skill.");
    await run.continueRun(next);
    expect((await run.prisma.run.findUniqueOrThrow({ where: { id: next } })).status).toBe(
      "completed",
    );
    expect(
      await run.prisma.volumeSkill.count({ where: { source: "shared", name: "shared-guide" } }),
    ).toBe(0);
    run.model.assertComplete();
  },
);

it.each(["storage", "ordering"])("protects the shared skill index, %s", async (scenario) => {
  const run = await startWorkerRun({ steps: [] });
  cleanups.push(() => run.close());
  const older = await run.send("Older");
  // Separate active runs, as two bots in a space can report in either order.
  const original = await run.prisma.run.findUniqueOrThrow({ where: { id: older } });
  const newer = "newer-skills-run";
  await run.prisma.run.create({ data: { ...original, id: newer } });
  for (const [id, startedAt] of [
    [older, new Date("2026-01-01")],
    [newer, new Date("2026-01-02")],
  ] as const) {
    await run.prisma.run.update({
      where: { id },
      data: { status: "running", leaseFence: 1, leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    await run.prisma.attempt.create({
      data: { runId: id, fence: 1, status: "running", startedAt },
    });
  }
  const content = buildSkillMd({
    name: "shared-guide",
    description: "Shared procedure",
    body: "token-from-another-bot",
  });
  const report = {
    name: "shared-guide",
    description: "Shared procedure",
    source: "shared" as const,
    path: "/workspace/shared/skills/shared-guide/SKILL.md",
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    files: [],
  };
  const owner = (runId: string) => ({
    spaceId: run.spaceId,
    userId: run.userId,
    botId: run.bot.id,
    runId,
    fence: 1,
  });
  await indexWorkerSkills(
    run.prisma,
    owner(older),
    [
      report,
      {
        ...report,
        name: "managed",
        source: "managed",
        content: buildSkillMd({
          name: "managed",
          description: "Shared procedure",
          body: "Managed",
        }),
        contentHash: createHash("sha256")
          .update(
            buildSkillMd({ name: "managed", description: "Shared procedure", body: "Managed" }),
          )
          .digest("hex"),
      },
    ],
    ["shared", "managed"],
    [],
  );
  if (scenario === "storage") {
    expect(
      await run.prisma.volumeSkill.findMany({ select: { source: true, content: true } }),
    ).toEqual([{ source: "shared", content: "" }]);
    return;
  }
  await indexWorkerSkills(run.prisma, owner(newer), [], ["shared"], []);
  await indexWorkerSkills(run.prisma, owner(older), [report], ["shared"], []);
  expect(await run.prisma.volumeSkill.count({ where: { source: "shared" } })).toBe(0);
});
