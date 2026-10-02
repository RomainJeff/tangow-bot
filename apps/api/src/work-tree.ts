import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { JobPublisher } from "@rakazo/adapter-kit";
import {
  createDelegatedTasks,
  readTaskTree,
  WorkHasOpenDescendantsError,
  WorkStillWorkingError,
} from "@rakazo/adapters";
import type { Actor, TaskTreeNode, ThreadMessagePage } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { loadMessagePage } from "./thread-message-pages.js";

type Deps = { prisma: PrismaClient; jobs: JobPublisher; events: Pick<ThreadEvents, "notify"> };

/** Most recent coordinator-level tasks a thread's tree lists; deeper levels are always whole. */
const ROOT_TASKS_MAX = 100;
const WORK_THREAD_PAGE_SIZE = 100;

/**
 * The tasks a coordinator's thread delegated, newest first, each with the tasks its specialist
 * delegated in turn. Tasks are read within the caller's own Space and ownership, by the thread
 * that delegated them.
 */
export async function workTree(
  deps: Deps,
  actor: Actor,
  threadId: string,
): Promise<TaskTreeNode[]> {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const roots = await deps.prisma.scopedTask.findMany({
    where: { ...scope, coordinatorThreadId: threadId, parentScopedTaskId: null },
    orderBy: { createdAt: "desc" },
    take: ROOT_TASKS_MAX,
  });
  return readTaskTree(deps.prisma, roots);
}

/** A task the caller owns, or nothing: the existence of someone else's is never revealed. */
async function ownedWork(deps: Deps, actor: Actor, workId: string) {
  const task = await deps.prisma.scopedTask.findFirst({
    where: { id: workId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!task) throw new IsolationError();
  return task;
}

/**
 * A specialist's own thread, read-only. The thread is derived from the owned task, so the
 * client never names it, and no write route reaches it.
 */
export async function workThread(
  deps: Deps,
  actor: Actor,
  input: { workId: string; before?: number },
): Promise<ThreadMessagePage> {
  const task = await ownedWork(deps, actor, input.workId);
  return loadMessagePage(deps.prisma, task.specialistThreadId, input.before, WORK_THREAD_PAGE_SIZE);
}

/**
 * The user acts through the task's own coordinator: the delegation core only lets a task's
 * coordinator cancel or close it, so ownership is checked here and the coordinator identity is
 * the one stored on the task. A closure is recorded as the user's decision.
 */
async function decideWork(
  deps: Deps,
  actor: Actor,
  workId: string,
  command: { kind: "cancel" } | { kind: "close" },
) {
  const task = await ownedWork(deps, actor, workId);
  return createDelegatedTasks({
    prisma: deps.prisma,
    jobs: deps.jobs,
    events: deps.events,
  }).apply(
    command.kind === "cancel"
      ? { kind: "cancel", workId, reason: "Cancelled by the user." }
      : { kind: "close", workId, decidedBy: "user" },
    {
      actor: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId: task.coordinatorBotId,
        rights: {},
      },
      originRunId: "",
      requestId: randomUUID(),
    },
  );
}

export async function cancelWork(deps: Deps, actor: Actor, workId: string): Promise<{ ok: true }> {
  await decideWork(deps, actor, workId, { kind: "cancel" });
  return { ok: true as const };
}

export async function closeWork(deps: Deps, actor: Actor, workId: string): Promise<{ ok: true }> {
  try {
    await decideWork(deps, actor, workId, { kind: "close" });
  } catch (error) {
    if (error instanceof WorkHasOpenDescendantsError || error instanceof WorkStillWorkingError) {
      throw new ORPCError("CONFLICT", { message: error.message });
    }
    throw error;
  }
  return { ok: true as const };
}
