/**
 * The end-of-exchange skill nudge: when an exchange the user started ends with a reply after a
 * long piece of work, or after a step failed while following a skill, the bot gets one private
 * turn to keep or fix its method. The turn runs in a session of its own once the run is over, with
 * no way to reach the user: its text is dropped, and its only tools read and write skills, under
 * the exchange's run id so a skill it saves gets its line under the reply.
 */
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolCompletion,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import type { ExchangeFact, SkillLearningMode, SkillNudgeSignal } from "@rakazo/core";
import {
  runStartedByUser,
  SKILL_NUDGE_TOOLS,
  skillNudgePrompt,
  skillNudgeSignal,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { builtinAgentTools } from "./builtin-tools.js";
import type { SkillLibrary } from "./skill-library.js";

/** A bot that changed the named skill this recently is not asked to change it again. */
const RECENT_EXCHANGES = 5;

export type SkillNudgeSkip =
  | "not_user_started"
  | "no_reply"
  | "budget_exhausted"
  | "already_nudged"
  | "wrote_skill"
  | "no_signal"
  | "recently_changed";

export type SkillNudgeDecision =
  | { nudge: false; reason: SkillNudgeSkip }
  | { nudge: true; mode: "shadow" | "on"; signal: SkillNudgeSignal };

export type SkillNudgeExchange = {
  run: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    threadId: string;
    trigger: string;
    createdAt: Date;
  };
  /** Who wrote a follow_up's or a messaging run's source message. */
  sourceRole?: string | null;
  /** The user saw an answer: a final reply or a message_user bubble. */
  replied: boolean;
  /** The exchange stopped on the tool-call limit. */
  budgetExhausted: boolean;
};

export type SkillNudgeDeps = {
  prisma: Pick<PrismaClient, "event" | "run">;
  events: Pick<ThreadEvents, "append">;
  library: Pick<SkillLibrary, "changesByRun">;
};

const FACT_EVENTS = ["agent.tool.completed", "agent.skill.used", "agent.skill.nudge"];
const SKILL_WRITE_TOOLS = new Set(["skill_create", "skill_update", "skill_delete"]);
/** Skips left unmarked: they say nothing about the threshold, or were counted once already. */
const UNRECORDED_SKIPS: ReadonlySet<SkillNudgeSkip> = new Set([
  "not_user_started",
  "already_nudged",
]);

async function exchangeFacts(prisma: SkillNudgeDeps["prisma"], runId: string) {
  const events = await prisma.event.findMany({
    where: { runId, type: { in: FACT_EVENTS } },
    orderBy: { seq: "asc" },
    select: { type: true, payload: true },
  });
  const facts: ExchangeFact[] = [];
  let nudged = false;
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "agent.skill.nudge") nudged ||= payload.phase === "decided";
    else if (event.type === "agent.skill.used") {
      facts.push({ kind: "skill_used", name: String(payload.name ?? "") });
    } else {
      facts.push({
        kind: "tool",
        name: String(payload.name ?? ""),
        outcome: String(payload.outcome ?? ""),
        byNudge: payload.nudge === true,
      });
    }
  }
  return { facts, nudged };
}

/**
 * Whether this exchange earns the nudge, read from what it persisted, so a resumed run counts
 * the calls of its earlier attempts and never asks twice. A nudge is marked before it runs; a
 * skip of a turn the user started is marked too, to read the rate back.
 */
export async function decideSkillNudge(
  deps: SkillNudgeDeps,
  mode: Exclude<SkillLearningMode, "off">,
  exchange: SkillNudgeExchange,
): Promise<SkillNudgeDecision> {
  const decision = await decide(deps, mode, exchange);
  const { run } = exchange;
  getLogger().info("agent.skill_nudge", {
    runId: run.id,
    mode,
    ...(decision.nudge
      ? { decision: "nudge", signal: decision.signal.signal, toolCount: decision.signal.toolCount }
      : { decision: "skip", reason: decision.reason }),
  });
  if (decision.nudge || !UNRECORDED_SKIPS.has(decision.reason)) {
    await deps.events.append({
      spaceId: run.spaceId,
      threadId: run.threadId,
      botId: run.botId,
      runId: run.id,
      type: "agent.skill.nudge",
      payload: decision.nudge
        ? { phase: "decided", mode, ...decision.signal }
        : { phase: "skipped", mode, reason: decision.reason },
    });
  }
  return decision;
}

async function decide(
  deps: SkillNudgeDeps,
  mode: Exclude<SkillLearningMode, "off">,
  { run, sourceRole, replied, budgetExhausted }: SkillNudgeExchange,
): Promise<SkillNudgeDecision> {
  const skip = (reason: SkillNudgeSkip): SkillNudgeDecision => ({ nudge: false, reason });
  if (!runStartedByUser({ trigger: run.trigger, sourceRole })) return skip("not_user_started");
  if (!replied) return skip("no_reply");
  if (budgetExhausted) return skip("budget_exhausted");
  const { facts, nudged } = await exchangeFacts(deps.prisma, run.id);
  if (nudged) return skip("already_nudged");
  const wroteSkill = facts.some(
    (fact) =>
      fact.kind === "tool" &&
      !fact.byNudge &&
      fact.outcome === "succeeded" &&
      SKILL_WRITE_TOOLS.has(fact.name),
  );
  if (wroteSkill) return skip("wrote_skill");
  const signal = skillNudgeSignal(facts);
  if (!signal) return skip("no_signal");
  const followed = new Set(
    facts.flatMap((fact) => (fact.kind === "skill_used" ? [fact.name.toLowerCase()] : [])),
  );
  if (followed.size === 0) return { nudge: true, mode, signal };
  const recent = await deps.prisma.run.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      id: { not: run.id },
      createdAt: { lt: run.createdAt },
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_EXCHANGES,
    select: { id: true },
  });
  if (recent.length === 0) return { nudge: true, mode, signal };
  const changes = await deps.library.changesByRun(
    run,
    recent.map(({ id }) => id),
  );
  const changedRecently = recent.some(({ id }) =>
    changes.get(id)?.some((change) => followed.has(change.name.toLowerCase())),
  );
  return changedRecently ? skip("recently_changed") : { nudge: true, mode, signal };
}

const withoutDraftFolder = (tool: ConnectorTool): ConnectorTool => {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  if (!schema.properties?.path) return tool;
  const { path: _, ...properties } = schema.properties;
  return {
    ...tool,
    description: tool.description.replace(/\s*Pass path to save a workspace folder[^.]*\./, ""),
    inputSchema: { ...tool.inputSchema, properties },
  };
};

/** The nudge's tools: skill reads and writes, without a draft folder it has no way to write. */
export const SKILL_NUDGE_TOOL_DEFS: ConnectorTool[] = builtinAgentTools
  .filter((tool) => SKILL_NUDGE_TOOLS.includes(tool.name))
  .map(withoutDraftFolder);

const NOT_HERE = {
  error: "Only skill_read, skill_search, skill_create and skill_update work here.",
};
const NO_FOLDER = { error: "Pass name, description and body, or content: no folder here." };

export type SkillNudgeTurn = {
  run: { id: string; spaceId: string; threadId: string; botId: string };
  signal: SkillNudgeSignal;
  /** The exchange's instructions, model and history, its reply included. */
  request: Pick<
    AgentRunRequest,
    "botId" | "threadId" | "instructions" | "history" | "model" | "secrets"
  >;
  context: Partial<AdapterContext>;
  /** Runs one skill tool as the exchange's bot, under the exchange's run id. */
  callTool: (name: string, args: Record<string, unknown>, toolCallId: string) => Promise<unknown>;
  /** Records a call in the exchange's steps, marked as the nudge's. */
  audit: (completion: AgentToolCompletion) => Promise<void>;
  /** Records the turn's model spend as the exchange's. */
  recordUsage: (usage: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<void>;
};

/**
 * One private turn with skill tools only. Nothing it emits is published, no steering is claimed,
 * so a message the user sends meanwhile starts its own run, and it runs under a run id of its own
 * so it shares no tool budget, abort or recorded session with the exchange.
 */
export async function runSkillNudgeTurn(
  deps: { runtime: AgentRuntime; events: Pick<ThreadEvents, "append"> },
  turn: SkillNudgeTurn,
): Promise<void> {
  const events = deps.runtime.run(
    {
      ...turn.request,
      runId: `${turn.run.id}:skill-nudge`,
      prompt: skillNudgePrompt(turn.signal),
      tools: SKILL_NUDGE_TOOL_DEFS,
      allowSilentEmpty: true,
      executeTool: async (name, args, executionId) => {
        if (!SKILL_NUDGE_TOOLS.includes(name)) return NOT_HERE;
        if (args.path !== undefined) return NO_FOLDER;
        return turn.callTool(name, args, `${turn.run.id}:skill-nudge:${executionId}`);
      },
      onToolCompleted: (completion) => turn.audit(completion),
    },
    turn.context,
  );
  try {
    for await (const event of events) {
      if (event.type === "usage") await turn.recordUsage(event);
    }
  } finally {
    await deps.events
      .append({
        spaceId: turn.run.spaceId,
        threadId: turn.run.threadId,
        botId: turn.run.botId,
        runId: turn.run.id,
        type: "agent.skill.nudge",
        payload: { phase: "ended" },
      })
      .catch((error) => getLogger().warn("skill nudge end mark failed", { error }));
  }
}
