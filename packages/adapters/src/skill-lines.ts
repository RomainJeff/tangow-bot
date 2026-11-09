/**
 * The "Skill learned · <name>" line: written by the server from the run's recorded skill writes,
 * never from the bot's text, with a `skill.learnt` entry per line in the session log. A run gets
 * its lines once, recorded on the run, whatever the number of calls or attempts, so a resume, a
 * replay or the sweep changes nothing, and neither does a conversation the user emptied since.
 */
import type { SessionLog } from "@rakazo/adapter-kit";
import type { SessionId } from "@rakazo/contracts";
import type { SkillSourceBlock } from "@rakazo/core";
import { asSkillAvailability, runStartedByUser, userSkillKey } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { threadEventSeq } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const FINISHED = ["completed", "failed", "cancelled"];
type SkillChange = SkillSourceBlock["change"];
/** Each skill write, folded onto what the run already did to that skill. */
const FOLD = new Map<string, (before?: SkillChange) => SkillChange>([
  ["skill_create", () => "learned"],
  ["skill_update", (before) => (before === "learned" ? "learned" : "updated")],
  ["skill_delete", () => "deleted"],
]);
const SKILL_WRITE_TOOLS = [...FOLD.keys()];
/** A run's writes have all landed by then, even those of a run cancelled mid-call. */
const SWEEP_GRACE_MS = 5 * 60 * 1000;
const SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type SkillLineDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify">;
  sessionLog: Pick<SessionLog<Prisma.TransactionClient>, "append">;
  /** Whether a run that said nothing still gets its lines, standing alone in a conversation. */
  lineOnlyMessages?: boolean;
};

/** Only a call that saved returns the skill's name; a refused one returns an error alone. */
const savedName = (result: Prisma.JsonValue): string | undefined =>
  result && typeof result === "object" && !Array.isArray(result) && typeof result.name === "string"
    ? result.name
    : undefined;

/**
 * Per run, one line per skill it wrote, in the order it first wrote them, from the effects of its
 * skill calls that succeeded. A bot cannot rename a skill, so the name it wrote stays the skill's id.
 */
export async function skillLinesByRun(
  prisma: Pick<PrismaClient, "externalEffect">,
  runIds: string[],
): Promise<Map<string, SkillSourceBlock[]>> {
  const effects = await prisma.externalEffect.findMany({
    where: { runId: { in: runIds }, kind: { in: SKILL_WRITE_TOOLS }, status: "completed" },
    orderBy: { createdAt: "asc" },
    select: { runId: true, kind: true, result: true },
  });
  const byRun = new Map<string, Map<string, SkillSourceBlock>>();
  for (const { runId, kind, result } of effects) {
    const fold = FOLD.get(kind);
    const name = savedName(result);
    if (!fold || !name) continue;
    const lines = byRun.get(runId) ?? new Map<string, SkillSourceBlock>();
    byRun.set(runId, lines);
    const skillId = userSkillKey(name);
    lines.set(skillId, {
      kind: "skill_source",
      skillId,
      name,
      change: fold(lines.get(skillId)?.change),
    });
  }
  return new Map([...byRun].map(([runId, lines]) => [runId, [...lines.values()]]));
}

/** The updated skills another bot reads, by the owner's access settings now. */
async function reachingOtherBots(
  tx: Prisma.TransactionClient,
  run: { spaceId: string; userId: string; botId: string },
  lines: SkillSourceBlock[],
): Promise<SkillSourceBlock[]> {
  const updated = lines.filter((line) => line.change === "updated");
  if (updated.length === 0) return [];
  const scope = {
    spaceId: run.spaceId,
    userId: run.userId,
    skillKey: { in: updated.map((line) => line.skillId) },
  };
  const settings = await tx.skillSetting.findMany({
    where: scope,
    select: { skillKey: true, availability: true },
  });
  const picked = await tx.botSkill.findMany({
    where: { ...scope, enabled: true, botId: { not: run.botId } },
    select: { skillKey: true },
  });
  const availability = new Map(settings.map((row) => [row.skillKey, row.availability]));
  const pickedKeys = new Set(picked.map((row) => row.skillKey));
  return updated.filter((line) => {
    const access = asSkillAvailability(availability.get(line.skillId));
    return access === "all" || (access === "selected" && pickedKeys.has(line.skillId));
  });
}

/**
 * Logs the line of each skill a finished run changed after what the run said. With
 * `lineOnlyMessages`, a run that said nothing gets its lines on their own, which marks nothing
 * unread: in its conversation when the user started the run, else in the bot's own conversation
 * and only for a skill other bots read. Without it the change shows nowhere. A cancelled run
 * writes its lines too.
 */
export async function writeSkillLines(deps: SkillLineDeps, runId: string): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      sessionId: true,
      trigger: true,
      status: true,
      skillLinesAt: true,
      sourceMessage: { select: { type: true } },
    },
  });
  if (!run || !FINISHED.includes(run.status) || run.skillLinesAt) return;
  const all = (await skillLinesByRun(deps.prisma, [run.id])).get(run.id) ?? [];
  const startedByUser = runStartedByUser({
    trigger: run.trigger,
    sourceRole: run.sourceMessage && (run.sourceMessage.type === "user.message" ? "user" : "bot"),
  });
  const lineOnlyThread = !deps.lineOnlyMessages
    ? undefined
    : startedByUser
      ? { id: run.threadId, sessionId: run.sessionId }
      : // A member's thread with a shared bot keeps its own lines out of the owner's thread.
        ((await deps.prisma.thread.findFirst({
          where: { id: run.threadId, memberBotId: { not: null } },
          select: { id: true, sessionId: true },
        })) ??
        (await deps.prisma.thread.findUnique({
          where: { botId: run.botId },
          select: { id: true, sessionId: true },
        })));
  const logLines = async (
    tx: Prisma.TransactionClient,
    sessionId: string,
    lines: SkillSourceBlock[],
  ) => {
    for (const line of lines) {
      await deps.sessionLog.append(tx, {
        type: "skill.learnt",
        sessionId: sessionId as SessionId,
        botId: run.botId,
        runId: run.id,
        payload: { skillId: line.skillId, name: line.name, change: line.change },
      });
    }
  };
  const written = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const threadId of new Set([run.threadId, lineOnlyThread?.id])) {
      if (threadId) await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    }
    const claimed = await tx.run.updateMany({
      where: { id: run.id, skillLinesAt: null },
      data: { skillLinesAt: new Date() },
    });
    if (claimed.count === 0 || all.length === 0) return null;
    const said = await tx.sessionEntry.findFirst({
      where: { runId: run.id, type: "assistant.text" },
      select: { id: true },
    });
    if (said) {
      await logLines(tx, run.sessionId, all);
      return { threadId: run.threadId, seq: await threadEventSeq(tx, run.threadId) };
    }
    if (!lineOnlyThread) return null;
    const lines = startedByUser ? all : await reachingOtherBots(tx, run, all);
    if (lines.length === 0) return null;
    await logLines(
      tx,
      lineOnlyThread.id === run.threadId ? run.sessionId : lineOnlyThread.sessionId,
      lines,
    );
    return { threadId: lineOnlyThread.id, seq: await threadEventSeq(tx, lineOnlyThread.id) };
  });
  if (written) {
    await deps.events.notify(written.threadId, written.seq).catch((error) => {
      getLogger().error("skill line realtime notification", error);
    });
  }
}

/**
 * Adds the lines of a run that ended over five minutes ago without them: a worker killed between
 * the write and the end of its run, a resumed run whose last attempt saved nothing. Only runs that
 * called a skill write and have no lines yet are read.
 */
export async function sweepSkillLines(deps: SkillLineDeps, now = new Date()): Promise<void> {
  const runs = await deps.prisma.run.findMany({
    where: {
      status: { in: FINISHED },
      updatedAt: {
        gte: new Date(now.getTime() - SWEEP_LOOKBACK_MS),
        lte: new Date(now.getTime() - SWEEP_GRACE_MS),
      },
      skillLinesAt: null,
      effects: { some: { kind: { in: SKILL_WRITE_TOOLS } } },
    },
    select: { id: true },
  });
  for (const { id } of runs) {
    await writeSkillLines(deps, id).catch((error) => getLogger().error("skill line sweep", error));
  }
}

/** The sweep as the job reconciler runs it: at most once every five minutes. */
export function createSkillLineSweep(
  deps: SkillLineDeps,
  options: { intervalMs?: number; now?: () => Date } = {},
): () => Promise<void> {
  let lastRun = 0;
  return async () => {
    const now = options.now?.() ?? new Date();
    if (now.getTime() - lastRun < (options.intervalMs ?? SWEEP_INTERVAL_MS)) return;
    lastRun = now.getTime();
    await sweepSkillLines(deps, now);
  };
}
