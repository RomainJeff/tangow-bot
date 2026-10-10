import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { SkillContent, SkillNudgeExchange } from "@rakazo/adapters";
import {
  createInMemorySkillLock,
  createSkillLibrary,
  decideSkillNudge,
  runSkillNudgeTurn,
  skillCreateFromTool,
  writeSkillLines,
} from "@rakazo/adapters";
import { buildSkillMd, skillNudgePrompt } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeThreadDb } from "./fake-thread-db.js";

const owner = { spaceId: "space-1", userId: "user-1" };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The access tables the skill library reads: no rows, so a user's skill is every bot's. */
function accessTables() {
  const table = () => ({
    findMany: async () => [],
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
  });
  return {
    skillSetting: table(),
    botSkill: table(),
    bot: { findMany: async () => [] },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  } as unknown as PrismaClient;
}

const skill = (name: string, body = "Steps"): SkillContent => ({
  kind: "skill-md",
  name,
  content: buildSkillMd({ name, description: `About ${name}`, body }),
});

const hour = (n: number) => new Date(Date.UTC(2026, 9, 10, n));

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-skill-nudge-"));
  dirs.push(dataDir);
  let tick = 0;
  const library = createSkillLibrary({
    prisma: accessTables(),
    dataDir,
    lock: createInMemorySkillLock(),
    now: () => new Date(Date.UTC(2026, 9, 10, 23, 0, tick++)),
  });
  const db = createFakeThreadDb();
  db.seedThread({ id: "thread-1" });
  db.seedRun({ id: "run-1", threadId: "thread-1", status: "running", createdAt: hour(12) });
  let seq = 0;
  const events = {
    append: async (input: Record<string, unknown>) => {
      seq += 1;
      const row = { id: `appended-${seq}`, seq, ...input };
      db.tables.events.set(row.id, row);
      return row as never;
    },
  };
  const record = (type: string, payload: Record<string, unknown>) =>
    events.append({
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      type,
      payload,
    });
  const toolCalls = async (count: number, name = "shell", outcome = "succeeded") => {
    for (let i = 0; i < count; i += 1) await record("agent.tool.completed", { name, outcome });
  };
  const exchange = (overrides: Partial<SkillNudgeExchange> = {}): SkillNudgeExchange => ({
    run: {
      id: "run-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      threadId: "thread-1",
      trigger: "user",
      createdAt: hour(12),
    },
    replied: true,
    budgetExhausted: false,
    ...overrides,
  });
  const writer = (runId: string) =>
    library.forBot(owner, {
      botId: "bot-1",
      botName: "Ada",
      runId,
      toolCallId: `${runId}-call`,
      secrets: [],
    });
  const deps = { prisma: db.prisma, events, library };
  const marks = () => db.eventsOfType("agent.skill.nudge").map((event) => event.payload);
  return { dataDir, db, library, deps, record, toolCalls, exchange, writer, marks };
}

describe("whether an exchange earns the skill nudge", () => {
  it("asks once after 15 tool calls, marked before the turn, even when asked again after a resume", async () => {
    const { deps, toolCalls, exchange, marks } = await setup();
    await toolCalls(15);

    expect(await decideSkillNudge(deps, "shadow", exchange())).toEqual({
      nudge: true,
      mode: "shadow",
      signal: { signal: "tools", toolCount: 15 },
    });
    expect(await decideSkillNudge(deps, "on", exchange())).toEqual({
      nudge: false,
      reason: "already_nudged",
    });
    expect(marks()).toEqual([{ phase: "decided", mode: "shadow", signal: "tools", toolCount: 15 }]);
  });

  it.each([
    ["a routine run", { trigger: "routine" }, {}, "not_user_started"],
    ["a webhook run", { trigger: "webhook" }, {}, "not_user_started"],
    [
      "another bot's follow-up",
      { trigger: "follow_up" },
      { sourceRole: "bot" },
      "not_user_started",
    ],
    ["an exchange with no reply", {}, { replied: false }, "no_reply"],
    [
      "an exchange stopped by the tool-call limit",
      {},
      { budgetExhausted: true },
      "budget_exhausted",
    ],
  ] as const)("skips %s", async (_label, run, overrides, reason) => {
    const { deps, toolCalls, exchange, marks } = await setup();
    await toolCalls(20);
    const base = exchange();

    expect(
      await decideSkillNudge(deps, "on", { ...base, ...overrides, run: { ...base.run, ...run } }),
    ).toEqual({ nudge: false, reason });
    expect(marks()).toEqual(
      reason === "not_user_started" ? [] : [{ phase: "skipped", mode: "on", reason }],
    );
  });

  it("skips an exchange that already saved a skill, or one too short", async () => {
    const { deps, toolCalls, exchange, marks } = await setup();
    await toolCalls(14);
    await toolCalls(3, "skill_read");
    await toolCalls(3, "shell", "error");
    await toolCalls(1, "skill_create", "error");
    expect(await decideSkillNudge(deps, "on", exchange())).toEqual({
      nudge: false,
      reason: "no_signal",
    });

    await toolCalls(1);
    await toolCalls(1, "skill_update");
    expect(await decideSkillNudge(deps, "on", exchange())).toEqual({
      nudge: false,
      reason: "wrote_skill",
    });
    expect(marks()).toEqual([
      { phase: "skipped", mode: "on", reason: "no_signal" },
      { phase: "skipped", mode: "on", reason: "wrote_skill" },
    ]);
  });

  it("reads the skill history only for an exchange that followed a skill and earns the nudge", async () => {
    const { deps, db, toolCalls, exchange } = await setup();
    db.seedRun({ id: "run-0", threadId: "thread-1", createdAt: hour(1) });
    const offline = {
      ...deps,
      library: { changesByRun: () => Promise.reject(new Error("skills unavailable")) },
    };
    await toolCalls(3);
    expect(await decideSkillNudge(offline, "shadow", exchange())).toEqual({
      nudge: false,
      reason: "no_signal",
    });
    await toolCalls(12);
    expect(await decideSkillNudge(offline, "shadow", exchange())).toEqual({
      nudge: true,
      mode: "shadow",
      signal: { signal: "tools", toolCount: 15 },
    });

    db.seedRun({ id: "run-2", threadId: "thread-1", status: "running", createdAt: hour(13) });
    const later = exchange({ run: { ...exchange().run, id: "run-2", createdAt: hour(13) } });
    await deps.events.append({
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-2",
      type: "agent.skill.used",
      payload: { name: "Coffee", via: "skill_read" },
    });
    await deps.events.append({
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-2",
      type: "agent.tool.completed",
      payload: { name: "shell", outcome: "error" },
    });
    await expect(decideSkillNudge(offline, "shadow", later)).rejects.toThrow("skills unavailable");
  });

  it("names the skill followed before a failure, unless a bot changed it in the last five exchanges", async () => {
    const { db, deps, library, record, exchange, writer } = await setup();
    await library.forOwner(owner).create(skill("Coffee"));
    db.seedRun({ id: "run-0", threadId: "thread-1", createdAt: hour(1) });
    await writer("run-0").update("user:coffee", skill("Coffee", "Better steps"));
    await record("agent.skill.used", { name: "Coffee", via: "skill_read" });
    await record("agent.tool.completed", { name: "browser_act", outcome: "error" });

    expect(await decideSkillNudge(deps, "on", exchange())).toEqual({
      nudge: false,
      reason: "recently_changed",
    });

    for (let n = 2; n <= 6; n += 1) {
      db.seedRun({ id: `run-${n}`, threadId: "thread-1", createdAt: hour(n) });
    }
    expect(await decideSkillNudge(deps, "on", exchange())).toEqual({
      nudge: true,
      mode: "on",
      signal: { signal: "skill_failed", toolCount: 0, skill: "Coffee" },
    });
  });
});

describe("the skill nudge's private turn", () => {
  it("offers skill tools only, publishes none of its words, and its skill gets the line under the reply", async () => {
    const { dataDir, db, library, record } = await setup();
    db.tables.runs.get("run-1")!.status = "completed";
    db.seedMessage({
      id: "reply",
      threadId: "thread-1",
      role: "bot",
      runId: "run-1",
      botId: "bot-1",
      blocks: [{ kind: "text", text: "Your table is booked." }],
    });
    const requests: AgentRunRequest[] = [];
    const answers: unknown[] = [];
    const runtime = {
      describe: () => ({ capabilities: { scripted: false } }),
      abort: async () => undefined,
      run: (request: AgentRunRequest) =>
        (async function* () {
          requests.push(request);
          answers.push(await request.executeTool!("message_user", { text: "Saved!" }, "call-0"));
          answers.push(
            await request.executeTool!("skill_create", { path: "skill-drafts/book" }, "call-1"),
          );
          const result = await request.executeTool!(
            "skill_create",
            { name: "Book a table", description: "Book a restaurant table", body: "1. Call." },
            "call-2",
          );
          answers.push(result);
          await request.onToolCompleted?.({
            name: "skill_create",
            executionId: "call-2",
            durationMs: 1,
            result,
          });
          yield {
            type: "usage" as const,
            provider: "scripted",
            model: "scripted",
            inputTokens: 900,
            outputTokens: 12,
          };
          yield { type: "text" as const, text: "I saved Book a table for you!" };
          yield { type: "done" as const, text: "I saved Book a table for you!" };
        })(),
    } as unknown as AgentRuntime;
    const signal = { signal: "tools" as const, toolCount: 17 };
    const skillDeps = { prisma: accessTables(), dataDir, learning: "on" as const };
    const botOwner = { ...owner, botId: "bot-1" };
    const spent: unknown[] = [];

    await runSkillNudgeTurn(
      { runtime, events: { append: (input) => record(input.type, input.payload) } },
      {
        run: { id: "run-1", spaceId: "space-1", threadId: "thread-1", botId: "bot-1" },
        signal,
        request: {
          botId: "bot-1",
          threadId: "thread-1",
          instructions: "You are Ada.",
          history: [],
          model: { provider: "scripted", id: "scripted" },
        },
        context: { userId: "user-1", spaceId: "space-1" },
        callTool: (_name, args, toolCallId) =>
          skillCreateFromTool(
            skillDeps,
            botOwner,
            library.forBot(owner, {
              botId: "bot-1",
              botName: "Ada",
              runId: "run-1",
              toolCallId,
              secrets: [],
            }),
            args,
          ),
        audit: (completion) =>
          record("agent.tool.completed", {
            name: completion.name,
            outcome: "succeeded",
            nudge: true,
          }),
        recordUsage: async (usage) => {
          spent.push(usage);
        },
      },
    );
    await writeSkillLines(
      { prisma: db.prisma, library, events: { notify: async () => undefined } },
      "run-1",
    );

    const request = requests[0]!;
    expect(requests).toHaveLength(1);
    expect(request).toMatchObject({
      runId: "run-1:skill-nudge",
      prompt: skillNudgePrompt(signal),
      allowSilentEmpty: true,
    });
    expect(request.claimSteering).toBeUndefined();
    expect(request.tools.map((tool) => tool.name)).toEqual([
      "skill_read",
      "skill_search",
      "skill_create",
      "skill_update",
    ]);
    expect(
      request.tools.filter((tool) => "path" in (tool.inputSchema.properties as object)),
    ).toEqual([]);
    expect(answers).toEqual([
      { error: "Only skill_read, skill_search, skill_create and skill_update work here." },
      { error: "Pass name, description and body, or content: no folder here." },
      expect.objectContaining({ ok: true, name: "Book a table" }),
    ]);
    expect([...db.tables.messages.values()].map((message) => message.blocks)).toEqual([
      [
        { kind: "text", text: "Your table is booked." },
        expect.objectContaining({ kind: "skill_source", name: "Book a table", change: "learned" }),
      ],
    ]);
    expect(db.eventsOfType("agent.skill.nudge").map((event) => event.payload)).toEqual([
      { phase: "ended" },
    ]);
    expect(db.eventsOfType("agent.tool.completed").map((event) => event.payload)).toEqual([
      { name: "skill_create", outcome: "succeeded", nudge: true },
    ]);
    expect(spent).toEqual([
      {
        type: "usage",
        provider: "scripted",
        model: "scripted",
        inputTokens: 900,
        outputTokens: 12,
      },
    ]);
  });
});
