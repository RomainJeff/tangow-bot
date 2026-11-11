import type { MessageBlock, SessionEntryType, ThreadEntry } from "@tangow/contracts";
import { ThreadEntrySchema } from "@tangow/contracts";
import { rpc } from "./helpers";
import type { Page, Request, Route } from "./test";

type ThreadTarget = { botId: string } | { groupId: string };

export async function threadEntries(
  page: Page,
  target: ThreadTarget & { includePeerRuns?: boolean },
): Promise<ThreadEntry[]> {
  return (await rpc<{ entries: ThreadEntry[] }>(page, "threads/messages", target)).entries;
}

/** Interactive runs end with `run.recap` in the thread; their `run.finished` stays in the child session. */
export function finishedRuns(entries: readonly ThreadEntry[]) {
  return entries.filter((entry) => entry.type === "run.recap");
}

export function blocksOf(entries: readonly ThreadEntry[]): MessageBlock[] {
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

export function answerOf(entries: readonly ThreadEntry[], cardId: string) {
  return entries.find(
    (entry) =>
      (entry.type === "user.message" && entry.payload.replyTo?.entryId === cardId) ||
      (entry.type === "card.answered" && entry.payload.target === cardId),
  );
}

export type EntryDraft = {
  id: string;
  ts: string;
  type: SessionEntryType;
  payload: unknown;
  botId?: string;
  runId?: string;
};

export const at = (minute: number) => `2026-09-17T09:${String(minute).padStart(2, "0")}:00.000Z`;

export function runStarted(
  botId: string,
  runId: string,
  minute: number,
  triggerId: string,
): EntryDraft {
  return {
    id: `${runId}-start`,
    ts: at(minute),
    type: "run.started",
    botId,
    runId,
    payload: {
      trigger: { kind: "message", entryId: triggerId },
      model: { provider: "e2e", id: "e2e-model" },
      effort: null,
    },
  };
}

export function runFinished(
  botId: string,
  runId: string,
  minute: number,
  status: "completed" | "cancelled" = "completed",
): EntryDraft {
  return {
    id: `${runId}-end`,
    ts: at(minute),
    type: "run.finished",
    botId,
    runId,
    payload: { status, usage: { inputTokens: 900, outputTokens: 40 } },
  };
}

export type ThreadPage = {
  entries: ThreadEntry[];
  olderCursor?: string | null;
  [field: string]: unknown;
};

const HYDRATE_RPC = /\/rpc\/(bootstrap|threads\/get)(?:\?|$)/;

/**
 * Rewrites every thread page the matching RPCs return, in place, until the returned unroute runs.
 * One handler covers both hydrate RPCs: overlapping routes race on reload ("already handled").
 */
export async function reshapeThreadPages(
  page: Page,
  transform: (thread: ThreadPage, request: Request) => void,
  rpcPattern: RegExp = HYDRATE_RPC,
): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    try {
      const response = await route.fetch();
      const body = (await response.json()) as {
        json?: Partial<ThreadPage> & { thread?: Partial<ThreadPage> | null };
      };
      for (const thread of [body.json, body.json?.thread]) {
        if (thread?.entries) transform(thread as ThreadPage, route.request());
      }
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Reload or the end of the test can cancel an in-flight intercepted request.
      if (
        /already handled|Target closed|Request context disposed|Response has been disposed|Test ended/i.test(
          String(error),
        )
      )
        return;
      throw error;
    }
  };
  await page.route(rpcPattern, handler);
  return () => page.unroute(rpcPattern, handler);
}

export async function showThread(
  page: Page,
  drafts: readonly EntryDraft[],
  snapshot: Record<string, unknown> = {},
) {
  await reshapeThreadPages(page, (thread) => {
    Object.assign(thread, {
      entries: chained(thread.entries, drafts),
      olderCursor: null,
      progress: [],
      ...snapshot,
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
}

function chained(real: readonly ThreadEntry[], drafts: readonly EntryDraft[]): ThreadEntry[] {
  const head = real.reduce<ThreadEntry | undefined>(
    (latest, entry) => (latest && latest.seq > entry.seq ? latest : entry),
    undefined,
  );
  let parentId: string | null = head?.id ?? null;
  let seq = head ? head.seq + 1 : 0;
  return drafts.map((draft) => {
    const entry = ThreadEntrySchema.parse({
      ...draft,
      seq,
      parentId,
    });
    parentId = entry.id;
    seq += 1;
    return entry;
  });
}
