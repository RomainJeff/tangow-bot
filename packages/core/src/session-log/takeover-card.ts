import type { ThreadItem } from "@rakazo/contracts";

/**
 * The live "Needs you" computer card: the newest one of a run waiting for the user's screen.
 * Liveness comes from the run, never from the card's own `state`.
 */
export function latestTakeoverItemId(
  items: readonly ThreadItem[],
  runs: readonly { id: string; status: string }[],
): string | null {
  const waitingRunIds = new Set(
    runs.filter((run) => run.status === "waiting_takeover").map((run) => run.id),
  );
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "message" || item.role !== "bot") continue;
    if (!item.runId || !waitingRunIds.has(item.runId)) continue;
    if (item.blocks.some((block) => block.kind === "computer" && block.state === "Needs you")) {
      return item.id;
    }
  }
  return null;
}
