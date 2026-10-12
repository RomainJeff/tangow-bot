import type { EntryId, ThreadEntry, ThreadMessagePage } from "@rakazo/contracts";
import { mergeEntries } from "@rakazo/core";

const PEER_HISTORY_PAGE_TIMEOUT_MS = 15_000;
const PEER_HISTORY_TOTAL_TIMEOUT_MS = 60_000;

type PeerHistoryPage = Pick<ThreadMessagePage, "entries" | "olderCursor">;

/** Load every peer-history page without allowing one request or the full scan to hang forever. */
export async function loadPeerHistory({
  signal,
  loadPage,
  pageTimeoutMs = PEER_HISTORY_PAGE_TIMEOUT_MS,
  totalTimeoutMs = PEER_HISTORY_TOTAL_TIMEOUT_MS,
}: {
  signal: AbortSignal;
  loadPage: (before: EntryId | undefined, signal: AbortSignal) => Promise<PeerHistoryPage>;
  pageTimeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<ThreadEntry[]> {
  const deadline = AbortSignal.timeout(totalTimeoutMs);
  let before: EntryId | undefined;
  const pages: (readonly ThreadEntry[])[] = [];
  do {
    const page = await loadPage(
      before,
      AbortSignal.any([signal, deadline, AbortSignal.timeout(pageTimeoutMs)]),
    );
    pages.push(page.entries);
    before = page.olderCursor ?? undefined;
  } while (before !== undefined);
  return mergeEntries([], pages.flat());
}
