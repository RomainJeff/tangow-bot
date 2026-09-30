import { createHash } from "node:crypto";
import { runJobKey } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { createGroupRepos } from "@rakazo/db";
import { cancelComputerRunWork } from "./computer-idle.js";
import { screenLeaseIdForRun } from "./computer-lifecycle.js";
import { toComputerRef } from "./computer-support.js";
import type { ExecutorDeps } from "./executor.js";

export async function manageBotGroup(
  deps: Pick<ExecutorDeps, "prisma" | "jobs" | "sandbox">,
  run: { id?: string; threadId?: string; botId: string; userId: string; spaceId: string },
  action: string,
  args: Record<string, unknown>,
  executionId: string,
) {
  const actor: Actor = { ...run, email: "", isDeploymentOwner: false };
  const groups = createGroupRepos(deps.prisma);
  if (action === "list_groups") return { ok: true, groups: await groups.listGroups(actor) };
  const name = args.name === undefined ? undefined : String(args.name).trim();
  const description = args.description === undefined ? undefined : String(args.description).trim();
  if (name !== undefined && (!name || name.length > 80))
    return { error: "name must contain 1 to 80 characters" };
  if (description !== undefined && description.length > 8000)
    return { error: "description exceeds 8000 characters" };
  const botIds =
    args.bot_ids === undefined
      ? undefined
      : Array.isArray(args.bot_ids)
        ? [...new Set([run.botId, ...args.bot_ids.map(String)])]
        : null;
  if (botIds === null) return { error: "bot_ids must be an array" };
  if (action === "create_group") {
    if (!name || !description)
      return { error: "name and description (objective, coordinator, deliverable) are required" };
    const id = `group_${createHash("sha256").update(`${run.spaceId}:${executionId}`).digest("hex").slice(0, 32)}`;
    const existing = await deps.prisma.chatGroup.findUnique({
      where: { id },
      select: { id: true },
    });
    if (existing) return { ok: true, group: groups.mapGroup(await groups.getGroup(actor, id)) };
    try {
      return {
        ok: true,
        group: await groups.createGroup(actor, {
          id,
          name,
          description,
          botIds: botIds ?? [run.botId],
        }),
      };
    } catch (error) {
      const winner = await deps.prisma.chatGroup.findUnique({
        where: { id },
        select: { id: true },
      });
      if (winner) return { ok: true, group: groups.mapGroup(await groups.getGroup(actor, id)) };
      throw error;
    }
  }
  const groupId = String(args.group_id ?? "");
  const group = await groups.getGroup(actor, groupId, {
    includeArchived: action === "archive_group",
  });
  if (!group.members.some((member) => member.bot.id === run.botId))
    return { error: "Join this group's membership before managing it" };
  if (action === "archive_group") {
    if (group.archivedAt) return { ok: true, groupId, archived: true };
    if (String(args.confirm_name ?? "") !== group.name)
      return { error: "confirm_name must exactly match the group name" };
    if (group.thread?.id === run.threadId)
      return { error: "Close the mission from your own chat after returning its final result" };
    const archived = await groups.archiveGroup(actor, groupId);
    await Promise.all(
      archived.cancelledRunIds.map((id) => deps.jobs.cancel(runJobKey(id)).catch(() => undefined)),
    );
    await Promise.all(
      archived.computers.map(async (computer) => {
        if (!computer.providerRef || !computer.executionBotId || !computer.executionRunId) return;
        const context = {
          operationId: "archive-group",
          traceId: executionId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: computer.executionBotId,
          runId: computer.executionRunId,
          screenLeaseId: screenLeaseIdForRun(
            { runId: computer.executionRunId, fence: computer.executionFence },
            computer.executionRunId,
          ),
          cancelRunWork: true,
          signal: new AbortController().signal,
        };
        const ref = toComputerRef(computer);
        await cancelComputerRunWork(
          deps.sandbox,
          ref,
          computer.id,
          computer.executionRunId,
          context,
        );
        await deps.sandbox.releaseScreen?.(ref, context).catch(() => undefined);
      }),
    );
    return { ok: true, groupId, archived: true, cancelledRunIds: archived.cancelledRunIds };
  }
  if (action === "update_group") {
    const updated = await groups.updateGroup(actor, {
      groupId,
      name,
      description,
      botIds: botIds ?? undefined,
    });
    await Promise.all(
      updated.cancelledRunIds.map((id) => deps.jobs.cancel(runJobKey(id)).catch(() => undefined)),
    );
    return { ok: true, group: updated.group };
  }
  return { error: "Unknown group action" };
}
