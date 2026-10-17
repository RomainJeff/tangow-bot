import { createHash } from "node:crypto";
import type { ArtifactStore, BackgroundJobPayloads } from "@rakazo/adapter-kit";
import { LinkPreviewBlock, type LinkPreviewCard } from "@rakazo/contracts";
import { linkMentionCandidates, messageHostsLinkPreview } from "@rakazo/core";
import {
  appendLinkBlocks,
  blocksOf,
  deleteLinkPreviewArtifactRows,
  type PrismaClient,
  runMessages,
  type ThreadEvents,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  type LinkPreviewServiceDeps,
  previewStoreContext,
  type ResolvedLinkPreview,
  removePreviewBytes,
  resolveLinkPreviewDetailed,
} from "./service.js";

/** The whole job, from the first read to the last write. */
export const LINK_PREVIEW_JOB_TIMEOUT_MS = 20_000;

/** What is left of the job: its abort signal and the instant it fires (epoch ms). */
interface JobBudget {
  signal: AbortSignal;
  deadlineAt: number;
}

export interface LinkPreviewJobDeps extends Omit<LinkPreviewServiceDeps, "prisma" | "artifacts"> {
  prisma: PrismaClient;
  artifacts: ArtifactStore;
  events: Pick<ThreadEvents, "notify">;
  /** Test seam: the deadline of the whole job. */
  timeoutMs?: number;
}

function kindOf(block: unknown): string | undefined {
  return block && typeof block === "object" ? (block as { kind?: string }).kind : undefined;
}

/**
 * The one link a message may get a preview for, or null: it has no text link, or already
 * carries a card or the removal marker, or is a kind of message previews are never made for
 * (`messageHostsLinkPreview`, the rule web and iOS draw by), or its link names a secret or leads
 * to a sign-in page.
 */
export function linkPreviewCandidate(message: { role: string; blocks: unknown }): string | null {
  const { blocks } = message;
  if (!Array.isArray(blocks) || !messageHostsLinkPreview({ role: message.role, blocks })) {
    return null;
  }
  if (blocks.some((block) => kindOf(block) === "link_preview")) return null;
  const text = blocks
    .flatMap((block) =>
      kindOf(block) === "text" && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("\n");
  return linkMentionCandidates(text)[0]?.url ?? null;
}

type ThreadScope = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string | null;
  groupId: string | null;
};

/**
 * `link.preview`: adds a preview card to a human message, or to the messages a completed run
 * addressed to the person. Takes identifiers only; everything else is read again here. Never
 * throws: a preview that cannot be made is simply not shown, and the job is not retried.
 */
export async function runLinkPreviewJob(
  deps: LinkPreviewJobDeps,
  payload: BackgroundJobPayloads["link.preview"],
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? LINK_PREVIEW_JOB_TIMEOUT_MS;
  const budget: JobBudget = {
    signal: AbortSignal.timeout(timeoutMs),
    deadlineAt: Date.now() + timeoutMs,
  };
  try {
    if ("messageId" in payload) await previewHumanMessage(deps, payload.messageId, budget);
    else await previewRunMessages(deps, payload.runId, budget);
  } catch (error) {
    // The error name only: the failing call may have carried a link.
    getLogger().warn("link preview job failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

async function previewHumanMessage(
  deps: LinkPreviewJobDeps,
  messageId: string,
  budget: JobBudget,
): Promise<void> {
  const message = await deps.prisma.sessionEntry.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      type: true,
      payload: true,
      session: { select: { thread: { select: threadScope } } },
      externalTranscriptFor: { select: { id: true } },
    },
  });
  const thread = message?.session.thread;
  // A message an external channel brought in is not one the person sent from the app.
  if (message?.type !== "user.message" || message.externalTranscriptFor || !thread) return;
  const link = linkPreviewCandidate({ role: "user", blocks: blocksOf(message) });
  if (link) await attachPreview(deps, thread, message.id, link, budget);
}

const threadScope = { id: true, spaceId: true, userId: true, botId: true, groupId: true } as const;

async function previewRunMessages(
  deps: LinkPreviewJobDeps,
  runId: string,
  budget: JobBudget,
): Promise<void> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { status: true, trigger: true, thread: { select: threadScope } },
  });
  // Only a run that ended well, and only one a person is reading (never bot to bot).
  if (run?.status !== "completed" || run.trigger === "bot_message") return;
  // The final reply and message_user posts are addressed to the person; narration never is.
  for (const message of await runMessages(deps.prisma, runId)) {
    if (budget.signal.aborted) return;
    if (message.midTurn && !message.toPerson) continue;
    const link = linkPreviewCandidate({ role: "bot", blocks: message.blocks });
    if (link) await attachPreview(deps, run.thread, message.id, link, budget);
  }
}

async function attachPreview(
  deps: LinkPreviewJobDeps,
  thread: ThreadScope,
  messageId: string,
  link: string,
  budget: JobBudget,
): Promise<void> {
  const scope = { spaceId: thread.spaceId, userId: thread.userId, source: "job" as const };
  const { preview } = await resolveLinkPreviewDetailed(
    deps,
    scope,
    link,
    budget.signal,
    budget.deadlineAt,
  );
  // Past the deadline the page may be gone from under us: write nothing.
  if (!preview || budget.signal.aborted) return;

  const artifact = preview.image
    ? await createPreviewArtifact(deps, thread, messageId, preview.image)
    : undefined;
  if (preview.image && !artifact) return;

  const parsed = LinkPreviewBlock.safeParse(cardBlock(link, preview, artifact?.id));
  const block = parsed.success ? (parsed.data as LinkPreviewCard) : undefined;
  const appended = block
    ? await appendLinkBlocks(deps.prisma, {
        spaceId: thread.spaceId,
        threadId: thread.id,
        messageId,
        blocks: [block],
      }).catch(() => undefined)
    : undefined;
  if (appended?.outcome !== "appended") {
    // Cleared, rewound, removed or already previewed meanwhile: the image has no card to serve.
    if (artifact) await discardPreviewArtifact(deps, thread, artifact);
    return;
  }
  await deps.events.notify(thread.id, appended.seq).catch((error) => {
    getLogger().error("link preview realtime notification", error);
  });
}

function cardBlock(link: string, preview: ResolvedLinkPreview, artifactId: string | undefined) {
  return {
    kind: "link_preview" as const,
    url: link,
    format: preview.format,
    ...(preview.title ? { title: preview.title } : {}),
    ...(preview.image && artifactId
      ? {
          image: {
            artifactId,
            width: preview.image.width,
            height: preview.image.height,
            ...(preview.image.fit ? { fit: preview.image.fit } : {}),
          },
        }
      : {}),
  };
}

type PreviewArtifact = { id: string; storageKey: string };

/**
 * Copies the cached image into an artifact owned like the thread's attachments (a bot thread's
 * bot, or a group and its first member bot), marked as a preview image and tied to the message.
 */
async function createPreviewArtifact(
  deps: LinkPreviewJobDeps,
  thread: ThreadScope,
  messageId: string,
  image: NonNullable<ResolvedLinkPreview["image"]>,
): Promise<PreviewArtifact | undefined> {
  const context = previewStoreContext(thread, "link-preview:artifact");
  let storageKey: string | undefined;
  try {
    const botId =
      thread.botId ??
      (thread.groupId
        ? (
            await deps.prisma.chatGroupMember.findFirst({
              where: { groupId: thread.groupId },
              orderBy: { createdAt: "asc" },
              select: { botId: true },
            })
          )?.botId
        : undefined);
    if (!botId) return undefined;
    const bytes = await deps.artifacts.get(image.key, context);
    const stored = await deps.artifacts.put(
      { name: "link-preview.webp", mimeType: "image/webp", bytes },
      context,
    );
    storageKey = stored.id;
    const row = await deps.prisma.artifact.create({
      data: {
        spaceId: thread.spaceId,
        userId: thread.userId,
        botId,
        groupId: thread.groupId,
        name: "link-preview.webp",
        mimeType: "image/webp",
        size: bytes.byteLength,
        hash: createHash("sha256").update(bytes).digest("hex"),
        storageKey,
        isLinkPreview: true,
        previewMessageId: messageId,
      },
      select: { id: true, storageKey: true },
    });
    return row;
  } catch {
    // The cached bytes are gone, or the message was deleted before the row could point at it.
    if (storageKey) await removePreviewBytes(deps.artifacts, thread, [storageKey]);
    return undefined;
  }
}

async function discardPreviewArtifact(
  deps: LinkPreviewJobDeps,
  thread: ThreadScope,
  artifact: PreviewArtifact,
): Promise<void> {
  await removePreviewBytes(deps.artifacts, thread, [artifact.storageKey]);
  await deleteLinkPreviewArtifactRows(deps.prisma, [artifact.id]).catch(() => undefined);
}
