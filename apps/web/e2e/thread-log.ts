import type { MessageBlock, SessionEntry, SessionEntryType } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import { rpc } from "./helpers";
import type { Page, Route } from "./test";

type ThreadTarget = { botId: string } | { groupId: string };

/** The newest page of a thread's log, as `threads.messages` serves it. */
export async function threadEntries(
  page: Page,
  target: ThreadTarget & { includePeerRuns?: boolean },
): Promise<SessionEntry[]> {
  return (await rpc<{ entries: SessionEntry[] }>(page, "threads/messages", target)).entries;
}

/** Every block the entries show: the words, the cards and the receipts. */
export function blocksOf(entries: readonly SessionEntry[]): MessageBlock[] {
  return entries.flatMap((entry): MessageBlock[] => {
    switch (entry.type) {
      case "user.message":
      case "assistant.text":
      case "bot.text":
        return entry.payload.blocks;
      case "assistant.ask":
      case "assistant.choice":
        return [entry.payload.block];
      default:
        return [];
    }
  });
}

/** The entry that settled a card: a reply naming it, or a `card.answered` targeting it. */
export function answerOf(entries: readonly SessionEntry[], cardId: string) {
  return entries.find(
    (entry) =>
      (entry.type === "user.message" && entry.payload.replyTo?.entryId === cardId) ||
      (entry.type === "card.answered" && entry.payload.target === cardId),
  );
}

/** An entry to show, without the chain fields the thread it lands in decides. */
export type EntryDraft = {
  id: string;
  ts: string;
  type: SessionEntryType;
  payload: unknown;
  botId?: string;
  runId?: string;
};

/** Both hydrate RPCs carry the thread; one handler avoids racing globs. */
const HYDRATE_RPC = /\/rpc\/(bootstrap|threads\/get)(?:\?|$)/;

/**
 * Serve `drafts` as the whole thread from both hydrate RPCs, with `snapshot` fields merged in,
 * then reload. They chain after the real head, so an entry the server appends later still follows.
 */
export async function showThread(
  page: Page,
  drafts: readonly EntryDraft[],
  snapshot: Record<string, unknown> = {},
) {
  await page.route(HYDRATE_RPC, async (route: Route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as {
        json?: { entries?: SessionEntry[]; thread?: { entries?: SessionEntry[] } | null };
      };
      for (const thread of [body.json, body.json?.thread]) {
        if (!thread?.entries) continue;
        Object.assign(thread, {
          entries: chained(thread.entries, drafts),
          olderCursor: null,
          progress: [],
          ...snapshot,
        });
      }
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (/already handled|Target closed|Request context disposed/i.test(String(error))) return;
      throw error;
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
}

function chained(real: readonly SessionEntry[], drafts: readonly EntryDraft[]): SessionEntry[] {
  const head = real.reduce<SessionEntry | undefined>(
    (latest, entry) => (latest && latest.seq > entry.seq ? latest : entry),
    undefined,
  );
  let parentId: string | null = head?.id ?? null;
  let seq = head ? head.seq + 1 : 0;
  return drafts.map((draft) => {
    const entry = SessionEntrySchema.parse({
      ...draft,
      sessionId: head?.sessionId ?? "e2e-session",
      seq,
      parentId,
    });
    parentId = entry.id;
    seq += 1;
    return entry;
  });
}
