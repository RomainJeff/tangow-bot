import { createHash } from "node:crypto";
import type { ArtifactStore, BackgroundJobPayloads } from "@rakazo/adapter-kit";
import { LinkMentionBlock, LinkPreviewBlock, type LinkPreviewCard } from "@rakazo/contracts";
import {
  isLinkOnlyMessage,
  type LinkCandidate,
  linkMentionCandidates,
  messageHostsLinkPreview,
} from "@rakazo/core";
import {
  appendLinkBlocks,
  blocksOf,
  deleteLinkPreviewArtifactRows,
  type PrismaClient,
  runMessages,
  type ThreadEvents,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { type IconReads, mentionOf } from "./read-link-preview.js";
import {
  type LinkPreviewServiceDeps,
  previewStoreContext,
  type ResolvedLinkPreview,
  removePreviewBytes,
  resolveLinkPreviewDetailed,
} from "./service.js";

/** The whole job, from the first read to the last write. */
export const LINK_PREVIEW_JOB_TIMEOUT_MS = 20_000;
/** Reads of one message's links in flight at once. */
const LINK_READS_IN_PARALLEL = 2;

/**
 * What the job's messages share: its abort signal, the instant it fires (epoch ms), and the site
 * icons read so far, so a run that links one site from several messages reads its icon once.
 */
interface JobBudget {
  signal: AbortSignal;
  deadlineAt: number;
  icons: IconReads;
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

/** A message's text and its links that may become mentions, the first of which may get a card. */
interface MessageLinks {
  text: string;
  links: LinkCandidate[];
}

const NO_LINKS: MessageLinks = { text: "", links: [] };

/**
 * No links for a kind of message previews are never made for (`messageHostsLinkPreview`, the
 * rule web and iOS draw by), or one that carries a preview block of its own (sent with its preview
 * off); otherwise its eligible links (`linkMentionCandidates`), which may be none.
 */
function messageLinks(message: { role: string; blocks: unknown }): MessageLinks {
  const { blocks } = message;
  if (!Array.isArray(blocks) || !messageHostsLinkPreview({ role: message.role, blocks })) {
    return NO_LINKS;
  }
  if (blocks.some((block) => kindOf(block) === "link_preview")) return NO_LINKS;
  const text = blocks
    .flatMap((block) =>
      kindOf(block) === "text" && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("\n");
  return { text, links: linkMentionCandidates(text) };
}

type ThreadScope = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string | null;
  groupId: string | null;
};

/**
 * `link.preview`: adds a preview card and link mentions to a human message, or to the messages a
 * completed run addressed to the person. Takes identifiers only; everything else is read again
 * here. Never throws: a preview that cannot be made is simply not shown, and the job is not
 * retried.
 */
export async function runLinkPreviewJob(
  deps: LinkPreviewJobDeps,
  payload: BackgroundJobPayloads["link.preview"],
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? LINK_PREVIEW_JOB_TIMEOUT_MS;
  const budget: JobBudget = {
    signal: AbortSignal.timeout(timeoutMs),
    deadlineAt: Date.now() + timeoutMs,
    icons: new Map(),
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
  const found = messageLinks({ role: "user", blocks: blocksOf(message) });
  if (found.links.length) await attachLinks(deps, thread, message.id, found, budget);
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
    const found = messageLinks({ role: "bot", blocks: message.blocks });
    if (found.links.length) await attachLinks(deps, run.thread, message.id, found, budget);
  }
}

/**
 * Reads a message's links two at a time in text order, then writes its card (first link, an
 * article or a photo) and one mention per link that was read, in one write and one notification.
 * A message that is nothing but its card's link gets no mention for it: the card takes the
 * bubble's place, and a client that does not know mentions would draw a bubble beside it.
 * Once the deadline passes or the space's quota says no, no further link is read: the rest stay
 * plain. A mention whose icon could not be copied is written without one (the neutral glyph), and
 * a later run never adds it, since a link that has its mention is not written again. Artifacts
 * the write did not keep (written meanwhile, removed, gone) are discarded.
 */
async function attachLinks(
  deps: LinkPreviewJobDeps,
  thread: ThreadScope,
  messageId: string,
  { text, links }: MessageLinks,
  budget: JobBudget,
): Promise<void> {
  const scope = { spaceId: thread.spaceId, userId: thread.userId, source: "job" as const };
  const { icons } = budget;
  const reads = await readInOrder(links, async (link, index) => {
    if (budget.signal.aborted) return undefined;
    const depth = index === 0 ? { icons } : { mention: true as const, icons };
    const resolution = await resolveLinkPreviewDetailed(
      deps,
      scope,
      link.url,
      budget.signal,
      budget.deadlineAt,
      depth,
    );
    return resolution.limited ? undefined : resolution;
  });

  const created: PreviewArtifact[] = [];
  const copy = async (image: { key: string }) => {
    const artifact = await createPreviewArtifact(deps, thread, messageId, image);
    if (artifact) created.push(artifact);
    return artifact;
  };
  const blocks: Array<LinkPreviewCard | LinkMentionBlock> = [];
  const [first] = links;
  const card = reads[0]?.preview;
  let cardAlone = false;
  if (first && card) {
    const artifact = card.image && (await copy(card.image));
    const parsed = LinkPreviewBlock.safeParse(cardBlock(first.url, card, artifact?.id));
    if (parsed.success && (!card.image || artifact)) {
      blocks.push(parsed.data as LinkPreviewCard);
      cardAlone = isLinkOnlyMessage(text, first.url);
    }
  }
  for (const [index, link] of links.entries()) {
    if (index === 0 && cardAlone) continue;
    const read = reads[index]?.read;
    const mention = read && mentionOf(link.url, read);
    if (!mention) continue;
    const icon = mention.icon && (await copy(mention.icon));
    const parsed = LinkMentionBlock.safeParse({
      kind: "link_mention",
      url: link.url,
      ...(mention.title ? { title: mention.title } : {}),
      ...(icon ? { icon: { artifactId: icon.id } } : {}),
    });
    if (parsed.success) blocks.push(parsed.data);
  }
  if (blocks.length === 0) return;

  const appended = await appendLinkBlocks(deps.prisma, {
    spaceId: thread.spaceId,
    threadId: thread.id,
    messageId,
    blocks,
  }).catch(() => undefined);
  const kept = new Set(appended?.outcome === "appended" ? appended.artifactIds : []);
  for (const artifact of created) {
    if (!kept.has(artifact.id)) await discardPreviewArtifact(deps, thread, artifact);
  }
  if (appended?.outcome !== "appended") return;
  await deps.events.notify(thread.id, appended.seq).catch((error) => {
    getLogger().error("link preview realtime notification", error);
  });
}

/**
 * `read` over `items` in order, `LINK_READS_IN_PARALLEL` at a time. Once one answers undefined
 * (out of time or quota), no further item starts, for good.
 */
async function readInOrder<T, R>(
  items: readonly T[],
  read: (item: T, index: number) => Promise<R | undefined>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = [];
  let next = 0;
  let stopped = false;
  const lane = async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      results[index] = await read(items[index] as T, index);
      if (results[index] === undefined) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: LINK_READS_IN_PARALLEL }, lane));
  return results;
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
 * Copies a cached image (a card's picture or a mention's icon) into an artifact owned like the
 * thread's attachments (a bot thread's bot, or a group and its first member bot), marked as a
 * preview image and tied to the message, so no file list, search or attachment ever shows it.
 */
async function createPreviewArtifact(
  deps: LinkPreviewJobDeps,
  thread: ThreadScope,
  messageId: string,
  image: { key: string },
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
