import type { Actor, MessageBlock, SearchHit } from "@rakazo/contracts";
import { LINK_BLOCK_KINDS, toThreadEntry } from "@rakazo/contracts";
import { extractLinksFromText, matchesSearchQuery, snippetAroundMatch } from "@rakazo/core";
import type { SessionEntryRow } from "@rakazo/db";
import {
  ENTRY_ON_CHAIN,
  groupMembershipFilter,
  groupPersonSql,
  Prisma,
  type PrismaClient,
  sessionEntryFromRow,
  sharedWithFilter,
} from "@rakazo/db";
import { withoutHiddenPeerRuns } from "./thread-message-pages.js";
import { userFileArtifact } from "./user-file-artifact.js";

const SEARCH_LIMIT = 25;
/** Cap name matches so content hits (messages/files/links/routines) keep most of the budget. */
const CONVERSATION_HIT_LIMIT = 5;
/** The entries of a thread's main session that hold what someone said, as message blocks. */
const MESSAGE_ENTRY_TYPES = Prisma.sql`('user.message', 'assistant.text', 'bot.text')`;

/** The JSON path of the blocks the SQL pre-filter may match: never a link's card or mention. */
const SEARCHABLE_BLOCKS = `$[*] ? (!exists(@.kind) || (${[...LINK_BLOCK_KINDS]
  .map((kind) => `@.kind != "${kind}"`)
  .join(" && ")}))`;

/** The columns of a searched entry, its own bot named apart from the thread's. */
const ENTRY_COLUMNS = Prisma.sql`e.id, e."sessionId", e.seq, e."parentId", e.type, e.payload,
  e."botId" AS "entryBotId", e."runId", e."createdAt"`;
type EntryColumns = Omit<SessionEntryRow, "botId"> & { entryBotId: string | null };

/**
 * The actor's own thread with a bot: the bot's thread when it is theirs, or their member thread
 * while the bot is still shared with them (`sharedBotIds`). A group thread passes too.
 */
function ownBotThread(sharedBotIds: string[]) {
  return Prisma.sql`(t."memberBotId" IS NULL OR t."memberBotId" = ANY(${sharedBotIds}))`;
}

/** The rows the thread shows, by the rule its own view follows: a hidden peer run stays out. */
async function shownRows<R extends EntryColumns>(prisma: PrismaClient, rows: R[]): Promise<R[]> {
  const entries = rows.map(({ entryBotId, ...row }) =>
    toThreadEntry(sessionEntryFromRow({ ...row, botId: entryBotId })),
  );
  const shown = new Set<string>(
    (await withoutHiddenPeerRuns(prisma, entries)).map((entry) => entry.id),
  );
  return rows.filter((row) => shown.has(row.id));
}

/**
 * Up to SEARCH_LIMIT matching rows the thread shows, read a page at a time, so the matches of a
 * hidden peer run never take a result slot.
 */
async function shownMatches<R extends EntryColumns>(
  prisma: PrismaClient,
  page: (offset: number) => Promise<R[]>,
): Promise<R[]> {
  const shown: R[] = [];
  for (let offset = 0; shown.length < SEARCH_LIMIT; offset += SEARCH_LIMIT) {
    const rows = await page(offset);
    shown.push(...(await shownRows(prisma, rows)));
    if (rows.length < SEARCH_LIMIT) break;
  }
  return shown.slice(0, SEARCH_LIMIT);
}

function blocksOfRow(row: EntryColumns): MessageBlock[] {
  return (row.payload as { blocks: MessageBlock[] }).blocks;
}

async function findArtifactMessages(
  prisma: PrismaClient,
  actor: Actor,
  artifacts: Array<{ id: string; targetId: string }>,
  target: "bot" | "group",
  sharedBotIds: string[],
): Promise<Map<string, { id: string; seq: number }>> {
  if (artifacts.length === 0) return new Map();
  const targetColumn =
    target === "bot" ? Prisma.sql`COALESCE(t."botId", t."memberBotId")` : Prisma.sql`t."groupId"`;
  const threadOwner =
    target === "bot"
      ? Prisma.sql`t."userId" = ${actor.userId}`
      : groupPersonSql(actor.userId, Prisma.sql`t."groupId"`);
  const candidates = Prisma.join(
    artifacts.map(({ id, targetId }) => Prisma.sql`(${id}, ${targetId})`),
  );
  const rows = await prisma.$queryRaw<Array<EntryColumns & { artifactId: string }>>(
    Prisma.sql`
      SELECT candidate."artifactId", message.*
      FROM (VALUES ${candidates}) AS candidate("artifactId", "targetId")
      CROSS JOIN LATERAL (
        SELECT ${ENTRY_COLUMNS}
        FROM session_entries e
        INNER JOIN sessions s ON s.id = e."sessionId" AND s.kind = 'thread'
        INNER JOIN threads t ON t.id = s."threadId"
        WHERE t."spaceId" = ${actor.spaceId}
          AND ${threadOwner}
          AND ${targetColumn} = candidate."targetId"
          AND ${ownBotThread(sharedBotIds)}
          AND e.type IN ${MESSAGE_ENTRY_TYPES}
          AND (e.payload -> 'blocks')::text ILIKE ('%' || candidate."artifactId" || '%')
          AND ${ENTRY_ON_CHAIN}
        ORDER BY e.seq DESC
        LIMIT ${SEARCH_LIMIT}
      ) message
      ORDER BY candidate."artifactId", message.seq DESC
    `,
  );
  // Each file's newest message the thread shows: one a hidden peer run wrote does not count.
  const newest = new Map<string, { id: string; seq: number }>();
  for (const { artifactId, id, seq } of await shownRows(prisma, rows)) {
    if (!newest.has(artifactId)) newest.set(artifactId, { id, seq });
  }
  return newest;
}

export async function querySpaceSearch(
  prisma: PrismaClient,
  actor: Actor,
  q: string,
): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];

  const conversationHits: SearchHit[] = [];
  const contentHits: SearchHit[] = [];
  const seen = new Set<string>();

  function pushInto(bucket: SearchHit[], hit: SearchHit, limit: number) {
    const key = [
      hit.kind,
      hit.botId ?? "",
      hit.groupId ?? "",
      hit.messageId ?? "",
      hit.artifactId ?? "",
      hit.routineId ?? "",
      hit.url ?? "",
    ].join(":");
    if (seen.has(key) || bucket.length >= limit) return;
    seen.add(key);
    bucket.push(hit);
  }

  const bots = await prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
      ],
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const bot of bots) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        botId: bot.id,
        botName: bot.name,
        title: bot.name,
        snippet: bot.title || bot.description || bot.name,
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  const groups = await prisma.chatGroup.findMany({
    where: {
      ...groupMembershipFilter(actor.userId, actor.spaceId),
      name: { contains: query, mode: "insensitive" },
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const group of groups) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        groupId: group.id,
        groupName: group.name,
        title: group.name,
        snippet: group.name,
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  const contentBudget = Math.max(0, SEARCH_LIMIT - conversationHits.length);
  const sharedBotIds = (
    await prisma.bot.findMany({
      where: sharedWithFilter(actor.userId, actor.spaceId),
      select: { id: true },
    })
  ).map((bot) => bot.id);

  const artifacts = await prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      groupId: null,
      botId: { not: null },
      ...userFileArtifact,
      name: { contains: query, mode: "insensitive" },
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const botArtifactMessages = await findArtifactMessages(
    prisma,
    actor,
    artifacts.flatMap((artifact) =>
      artifact.botId && artifact.bot ? [{ id: artifact.id, targetId: artifact.botId }] : [],
    ),
    "bot",
    sharedBotIds,
  );
  for (const artifact of artifacts) {
    if (!artifact.botId || !artifact.bot) continue;
    const message = botArtifactMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        botId: artifact.botId,
        botName: artifact.bot.name,
        title: artifact.name,
        snippet: `${artifact.mimeType} · ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  // A group's files are everyone's in it, whoever added them.
  const groupArtifacts = await prisma.artifact.findMany({
    where: {
      spaceId: actor.spaceId,
      group: groupMembershipFilter(actor.userId),
      ...userFileArtifact,
      name: { contains: query, mode: "insensitive" },
    },
    include: { group: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const groupArtifactMessages = await findArtifactMessages(
    prisma,
    actor,
    groupArtifacts.flatMap((artifact) =>
      artifact.groupId && artifact.group ? [{ id: artifact.id, targetId: artifact.groupId }] : [],
    ),
    "group",
    sharedBotIds,
  );
  for (const artifact of groupArtifacts) {
    if (!artifact.groupId || !artifact.group) continue;
    const message = groupArtifactMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        groupId: artifact.groupId,
        groupName: artifact.group.name,
        title: artifact.name,
        snippet: `${artifact.mimeType} · ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  const routines = await prisma.routine.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { prompt: { contains: query, mode: "insensitive" } },
      ],
      // A routine on a bot no longer shared with its creator goes with their hidden thread.
      bot: {
        OR: [
          { userId: actor.userId, archivedAt: null },
          sharedWithFilter(actor.userId, actor.spaceId),
        ],
      },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const routine of routines) {
    pushInto(
      contentHits,
      {
        kind: "routine",
        botId: routine.botId,
        botName: routine.bot.name,
        title: routine.name,
        snippet: snippetAroundMatch(routine.prompt, query),
        routineId: routine.id,
      },
      contentBudget,
    );
  }

  // Preview cards are cut out of the JSON before the match: a page title must not take a result slot.
  const pattern = `%${query}%`;
  const messageRows = await shownMatches(
    prisma,
    (offset) => prisma.$queryRaw<
      Array<EntryColumns & { threadId: string; botId: string; botName: string }>
    >`
    SELECT ${ENTRY_COLUMNS}, t.id AS "threadId", b.id AS "botId", b.name AS "botName"
    FROM session_entries e
    INNER JOIN sessions s ON s.id = e."sessionId" AND s.kind = 'thread'
    INNER JOIN threads t ON t.id = s."threadId"
    INNER JOIN bots b ON b.id = COALESCE(t."botId", t."memberBotId")
    WHERE t."spaceId" = ${actor.spaceId}
      AND t."userId" = ${actor.userId}
      AND ${ownBotThread(sharedBotIds)}
      AND b."archivedAt" IS NULL
      AND e.type IN ${MESSAGE_ENTRY_TYPES}
      AND jsonb_path_query_array(e.payload -> 'blocks', ${SEARCHABLE_BLOCKS}::jsonpath)::text ILIKE ${pattern}
      AND ${ENTRY_ON_CHAIN}
    ORDER BY e."createdAt" DESC, e.id
    LIMIT ${SEARCH_LIMIT} OFFSET ${offset}
  `,
  );

  for (const row of messageRows) {
    pushMessageHits(blocksOfRow(row), {
      botId: row.botId,
      botName: row.botName,
      messageId: row.id,
      seq: row.seq,
      query,
      push: (hit) => pushInto(contentHits, hit, contentBudget),
    });
  }

  const groupMessageRows = await shownMatches(
    prisma,
    (offset) => prisma.$queryRaw<
      Array<EntryColumns & { threadId: string; groupId: string; groupName: string }>
    >`
    SELECT ${ENTRY_COLUMNS}, t.id AS "threadId", g.id AS "groupId", g.name AS "groupName"
    FROM session_entries e
    INNER JOIN sessions s ON s.id = e."sessionId" AND s.kind = 'thread'
    INNER JOIN threads t ON t.id = s."threadId"
    INNER JOIN chat_groups g ON g.id = t."groupId"
    WHERE t."spaceId" = ${actor.spaceId}
      AND ${groupPersonSql(actor.userId, Prisma.sql`g.id`)}
      AND e.type IN ${MESSAGE_ENTRY_TYPES}
      AND jsonb_path_query_array(e.payload -> 'blocks', ${SEARCHABLE_BLOCKS}::jsonpath)::text ILIKE ${pattern}
      AND ${ENTRY_ON_CHAIN}
    ORDER BY e."createdAt" DESC, e.id
    LIMIT ${SEARCH_LIMIT} OFFSET ${offset}
  `,
  );

  for (const row of groupMessageRows) {
    pushMessageHits(blocksOfRow(row), {
      groupId: row.groupId,
      groupName: row.groupName,
      messageId: row.id,
      seq: row.seq,
      query,
      push: (hit) => pushInto(contentHits, hit, contentBudget),
    });
  }

  return [...conversationHits, ...contentHits].slice(0, SEARCH_LIMIT);
}

function pushMessageHits(
  blocks: MessageBlock[],
  ctx: {
    botId?: string;
    botName?: string;
    groupId?: string;
    groupName?: string;
    messageId: string;
    seq: number;
    query: string;
    push: (hit: SearchHit) => void;
  },
) {
  // Discriminate on groupId (not name): empty group names must still target the group.
  const destination = ctx.groupId
    ? { groupId: ctx.groupId, groupName: ctx.groupName ?? "" }
    : { botId: ctx.botId!, botName: ctx.botName! };
  const title = ctx.groupId ? (ctx.groupName ?? "") : (ctx.botName ?? "");
  let messageHit = false;
  for (const block of blocks) {
    if (block.kind !== "text") continue;
    const text = block.text;
    if (matchesSearchQuery(ctx.query, text)) {
      ctx.push({
        kind: "message",
        ...destination,
        title,
        snippet: snippetAroundMatch(text, ctx.query),
        messageId: ctx.messageId,
        seq: ctx.seq,
      });
      messageHit = true;
    }
    for (const url of extractLinksFromText(text)) {
      if (matchesSearchQuery(ctx.query, url)) {
        ctx.push({
          kind: "link",
          ...destination,
          title: url,
          snippet: snippetAroundMatch(text, ctx.query),
          messageId: ctx.messageId,
          seq: ctx.seq,
          url,
        });
      }
    }
  }
  // A link's card or mention holds page content (title, image id), not anything anyone wrote.
  const searchable = blocks.filter((block) => !LINK_BLOCK_KINDS.has(block.kind));
  if (!messageHit && matchesSearchQuery(ctx.query, JSON.stringify(searchable))) {
    ctx.push({
      kind: "message",
      ...destination,
      title,
      snippet: ctx.query,
      messageId: ctx.messageId,
      seq: ctx.seq,
    });
  }
}
