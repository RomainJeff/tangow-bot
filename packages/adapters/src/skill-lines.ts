/**
 * The "Skill learned · <name>" line: written by the server from the skill history, never from the
 * bot's text. A run gets its lines once, recorded on the run, whatever the number of calls or
 * attempts, so a resume, a replay or the sweep changes nothing, and neither does a conversation
 * the user emptied since.
 */
import type { MessageBlock } from "@rakazo/contracts";
import type { SkillSourceBlock } from "@rakazo/core";
import { runStartedByUser } from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  messageUpdatedPayload,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { SkillLibrary, SkillRunChange } from "./skill-library.js";

/** The clientNonce of a message that carries a run's lines alone. */
const LINE_ONLY_NONCE_PREFIX = "skill-source:";
const FINISHED = ["completed", "failed", "cancelled"];
/** The tool calls whose effects mark a run that may have changed a skill. */
const SKILL_WRITE_TOOLS = ["skill_create", "skill_update", "skill_delete"];
/** A run's writes have all landed by then, even those of a run cancelled mid-call. */
const SWEEP_GRACE_MS = 5 * 60 * 1000;
const SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type SkillLineDeps = {
  prisma: PrismaClient;
  library: SkillLibrary;
  events: Pick<ThreadEvents, "notify">;
  /**
   * Whether a run that left no message gets one carrying its lines alone. Clients that predate
   * the line draw such a message as an empty row, so it stays off until they are gone.
   */
  lineOnlyMessages?: boolean;
};

const lineOf = (change: SkillRunChange): SkillSourceBlock => ({
  kind: "skill_source",
  skillUid: change.uid,
  skillId: change.key,
  name: change.name,
  change: change.change,
});

/**
 * Puts the line of each skill a finished run changed under the run's last message, the reply or an
 * earlier bubble alike. With `lineOnlyMessages`, a run with no message gets a message of its own,
 * which marks nothing unread: in its conversation when the user started the run, else in the
 * bot's own conversation and only for a change other bots read. Without it the change stays in
 * the skill's history alone. A cancelled run writes its lines too.
 */
export async function writeSkillLines(
  deps: SkillLineDeps,
  runId: string,
  changes?: SkillRunChange[],
): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      botId: true,
      threadId: true,
      trigger: true,
      status: true,
      skillLinesAt: true,
      sourceMessage: { select: { role: true } },
    },
  });
  if (!run || !FINISHED.includes(run.status) || run.skillLinesAt) return;
  const all = changes ?? (await deps.library.changesByRun(run, [run.id])).get(run.id) ?? [];
  const startedByUser = runStartedByUser({
    trigger: run.trigger,
    sourceRole: run.sourceMessage?.role,
  });
  const lineOnlyThreadId = !deps.lineOnlyMessages
    ? undefined
    : startedByUser
      ? run.threadId
      : (
          await deps.prisma.thread.findUnique({
            where: { botId: run.botId },
            select: { id: true },
          })
        )?.id;
  const written = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const threadId of new Set([run.threadId, lineOnlyThreadId])) {
      if (threadId) await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
    }
    const claimed = await tx.run.updateMany({
      where: { id: run.id, skillLinesAt: null },
      data: { skillLinesAt: new Date() },
    });
    if (claimed.count === 0 || all.length === 0) return null;
    const target = (
      await tx.message.findMany({
        where: { threadId: run.threadId, runId: run.id, role: "bot", hiddenFromThread: false },
        orderBy: { seq: "asc" },
        select: {
          id: true,
          threadId: true,
          role: true,
          blocks: true,
          botId: true,
          replyToMessageId: true,
          replyQuote: true,
        },
      })
    ).at(-1);
    if (target) {
      if (!Array.isArray(target.blocks)) return null;
      const blocks = [
        ...(target.blocks as Prisma.InputJsonValue[]),
        ...all.map((change) => lineOf(change) as Prisma.InputJsonValue),
      ];
      await tx.message.update({ where: { id: target.id }, data: { blocks } });
      // No run id: the run may be cancelled, and a run id makes clients drop its live progress.
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: target.threadId,
        botId: target.botId ?? run.botId,
        type: "thread.message.updated",
        payload: messageUpdatedPayload(target, blocks),
      });
      return { threadId: target.threadId, seq: event.seq };
    }
    const shown = startedByUser ? all : all.filter((change) => change.reachesOtherBots);
    if (shown.length === 0 || !lineOnlyThreadId) return null;
    const blocks: MessageBlock[] = shown.map(lineOf);
    const message = await createThreadMessageInTransaction(tx, {
      threadId: lineOnlyThreadId,
      role: "bot",
      blocks,
      botId: run.botId,
      clientNonce: `${LINE_ONLY_NONCE_PREFIX}${run.id}`,
      markUnread: false,
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: run.spaceId,
      threadId: lineOnlyThreadId,
      botId: run.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { threadId: lineOnlyThreadId, seq: event.seq };
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
 * called a skill write and have no lines yet are read, each owner's history once for all of them.
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
    select: { id: true, spaceId: true, userId: true },
  });
  const byOwner = new Map<string, { owner: { spaceId: string; userId: string }; ids: string[] }>();
  for (const { id, spaceId, userId } of runs) {
    const key = `${spaceId}/${userId}`;
    const entry = byOwner.get(key) ?? { owner: { spaceId, userId }, ids: [] };
    entry.ids.push(id);
    byOwner.set(key, entry);
  }
  for (const { owner, ids } of byOwner.values()) {
    try {
      const byRun = await deps.library.changesByRun(owner, ids);
      for (const id of ids) await writeSkillLines(deps, id, byRun.get(id) ?? []);
    } catch (error) {
      getLogger().error("skill line sweep", error);
    }
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
