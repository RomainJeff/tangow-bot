import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { TERMINAL_WORK_STATUSES } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { isSecretAskBlock } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { InvalidAnswerError, IsolationError } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const DELEGATED_TRIGGERS = ["delegate", "delegate_followup"];

/**
 * Answer a specialist's pending ask from the coordinator's thread. Ownership is checked here —
 * `answerRunInputInTransaction` only re-checks the user for permanent rules and secrets — and
 * the thread is always derived server-side from the scoped task: the client never names the
 * `work` thread, which no `threads.*` route can reach.
 */
export async function answerDelegatedWork(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "answerRunInput">;
    jobs: JobPublisher;
  },
  actor: Actor,
  input: { workId: string; runId: string; messageId: string; answer: string },
): Promise<{ ok: true }> {
  const work = await deps.prisma.scopedTask.findFirst({
    where: {
      id: input.workId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: { notIn: TERMINAL_WORK_STATUSES },
    },
    select: { id: true, specialistThreadId: true },
  });
  if (!work) throw new IsolationError();
  const run = await deps.prisma.run.findFirst({
    where: {
      id: input.runId,
      scopedTaskId: work.id,
      threadId: work.specialistThreadId,
      trigger: { in: DELEGATED_TRIGGERS },
    },
    select: { id: true },
  });
  if (!run) throw new IsolationError();
  if (await isDelegatedSecretAsk(deps.prisma, work.specialistThreadId, input)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "A delegated secret request cannot be answered from the coordinator's thread.",
    });
  }
  const answered = await deps.events
    .answerRunInput({
      spaceId: actor.spaceId,
      threadId: work.specialistThreadId,
      runId: input.runId,
      messageId: input.messageId,
      answeredByUserId: actor.userId,
      answer: input.answer,
    })
    .catch((error: unknown) => {
      // The prompt is still pending — the payload is the problem, so don't report it as
      // a stale prompt. Same mapping as threads.answer.
      if (error instanceof InvalidAnswerError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      throw error;
    });
  if (!answered) {
    throw new ORPCError("CONFLICT", {
      message: "This prompt is no longer awaiting an answer",
    });
  }
  await deps.jobs.enqueue(runContinueJob(input.runId)).catch((error) => {
    // The answer and queued run are durable; the reconciler repairs a missed immediate wake.
    getLogger().error("work answer enqueue", error);
  });
  return { ok: true as const };
}

/**
 * Secrets delegated to a specialist stay in reserve: this path never carries a
 * runSecretWriter, so refuse up front instead of surfacing a stale-prompt conflict.
 */
async function isDelegatedSecretAsk(
  prisma: PrismaClient,
  threadId: string,
  input: { runId: string; messageId: string },
): Promise<boolean> {
  const message = await prisma.message.findFirst({
    where: { id: input.messageId, threadId, runId: input.runId, role: "bot" },
    select: { blocks: true },
  });
  if (!message) return false;
  const parsed = MessageBlockSchema.array().safeParse(message.blocks);
  if (!parsed.success) return false;
  const pendingAsk = parsed.data.find(
    (block) => block.kind === "ask" && block.status !== "answered",
  );
  return pendingAsk?.kind === "ask" && isSecretAskBlock(pendingAsk);
}
