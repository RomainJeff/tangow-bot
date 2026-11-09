import type { SessionEntry, SessionEntryType } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, plainText, visibleEntries } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { hiddenPeerRunIds } from "./peer-runs.js";
import type { SessionEntryRow } from "./sessions.js";
import { sessionEntryFromRow } from "./sessions.js";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];

/** The run a thread shows as its status: a helper works out of sight, behind its parent's turn. */
export const activeRunSelection = {
  where: { status: { in: activeRunStatuses }, parentRunId: null },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

/**
 * The run its owner sees as a bot's status, from `bot.runs`: the runs of the people it is shared
 * with are in their own threads, and theirs alone to see.
 */
export const ownerRunSelection = {
  ...activeRunSelection,
  where: { ...activeRunSelection.where, thread: { memberBotId: null } },
} as const;

const SKILL_LINE_PREVIEW = {
  learned: "Skill learned",
  updated: "Skill updated",
  deleted: "Skill deleted",
} as const;

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    // Legacy reasoning blocks carry text but are not part of the answer.
    if (block && typeof block === "object" && (block as { kind?: unknown }).kind === "reasoning") {
      continue;
    }
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      // A block made only of syntax (`---`, `[](url)`) says nothing: look further.
      const text = plainText((block as { text: string }).text);
      if (text) return text;
    }
  }
  return "";
}

const PREVIEW_TYPES = [
  "user.message",
  "assistant.text",
  "assistant.ask",
  "assistant.choice",
  "bot.text",
  "routine.finished",
  "skill.learnt",
  "system.note",
] as const satisfies readonly SessionEntryType[];
/** How far back along a chain a preview is looked for, past a long run's tool calls. */
const PREVIEW_CHAIN_DEPTH = 400;

/** What a thread list shows of one entry, empty when it says nothing. */
export function entryPreview(entry: SessionEntry): string {
  switch (entry.type) {
    case "user.message":
    case "assistant.text":
    case "bot.text":
      return previewFromBlocks(entry.payload.blocks);
    case "assistant.ask":
      return plainText(entry.payload.block.text);
    case "assistant.choice":
      return plainText(entry.payload.block.question);
    case "routine.finished":
      return plainText(entry.payload.result);
    case "skill.learnt":
      return `${SKILL_LINE_PREVIEW[entry.payload.change]} · ${entry.payload.name}`;
    case "system.note":
      return plainText(entry.payload.text);
    default:
      return "";
  }
}

/**
 * Each session's preview: the newest entry on its chain that says something and that the thread
 * shows, so a peer run it hides counts only for what it puts to the person.
 */
export async function sessionPreviews(
  prisma: PrismaClient | Prisma.TransactionClient,
  sessionIds: readonly string[],
): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<SessionEntryRow[]>`
    WITH RECURSIVE chain AS (
      SELECT e.id, e."parentId", 1 AS depth
      FROM sessions s JOIN session_entries e ON e.id = s."headEntryId"
      WHERE s.id = ANY(${[...sessionIds]}::text[])
      UNION ALL
      SELECT e.id, e."parentId", chain.depth + 1
      FROM chain JOIN session_entries e ON e.id = chain."parentId"
      WHERE chain.depth < ${PREVIEW_CHAIN_DEPTH})
    SELECT e.* FROM chain JOIN session_entries e ON e.id = chain.id
    WHERE e.type = ANY(${[...PREVIEW_TYPES]}::text[])
    ORDER BY e."sessionId", e.seq DESC`;
  const entries = rows.map(sessionEntryFromRow);
  const runIds = [...new Set(entries.flatMap((entry) => entry.runId ?? []))];
  const hidden = await hiddenPeerRunIds(prisma, runIds);
  const shown = new Set(
    visibleEntries(entries, { hiddenPeerRunIds: hidden }).map((entry) => entry.id),
  );
  const previews = new Map<string, string>();
  for (const entry of entries) {
    if (previews.has(entry.sessionId) || !shown.has(entry.id)) continue;
    const preview = entryPreview(entry);
    if (preview) previews.set(entry.sessionId, preview);
  }
  return previews;
}
