import type { ThreadEntry } from "@rakazo/contracts";
import type { ThreadRow } from "@rakazo/core";

/** Who wrote a person's message in a group: its author, else the group's creator. */
export function messageAuthorId(
  item: ThreadRow["item"],
  creatorId: string | undefined,
): string | undefined {
  if (item.kind !== "message" || item.role !== "user") return undefined;
  return item.authorId ?? creatorId;
}

/**
 * The thread's rows with a group ending wherever the person writing changes, so each person's
 * messages carry their own name and avatar.
 */
export function splitRowsByPerson(rows: ThreadRow[], creatorId: string | undefined): ThreadRow[] {
  const authors = rows.map((row) => messageAuthorId(row.item, creatorId));
  return rows.map((row, index) => {
    const author = authors[index];
    if (author === undefined) return row;
    const before = authors[index - 1];
    const after = authors[index + 1];
    const firstOfGroup = row.firstOfGroup || (before !== undefined && before !== author);
    const lastOfGroup = row.lastOfGroup || (after !== undefined && after !== author);
    return firstOfGroup === row.firstOfGroup && lastOfGroup === row.lastOfGroup
      ? row
      : { ...row, firstOfGroup, lastOfGroup };
  });
}

/**
 * The runs woken for another person of the group: their cards show, but only that person answers
 * them. A run nobody's message woke (a routine) stays unattributed, and the server decides.
 */
export function otherPeoplesRunIds(
  entries: readonly ThreadEntry[],
  viewerId: string | undefined,
  creatorId: string | undefined,
): Set<string> {
  const others = new Set<string>();
  if (!viewerId) return others;
  const byId = new Map(entries.map((entry) => [entry.id as string, entry]));
  const starts = new Map<string, Extract<ThreadEntry, { type: "run.started" }>>();
  for (const entry of entries) if (entry.type === "run.started") starts.set(entry.runId, entry);

  const personOf = (runId: string, seen: Set<string>): string | undefined => {
    const trigger = starts.get(runId)?.payload.trigger;
    if (!trigger || seen.has(runId)) return undefined;
    seen.add(runId);
    if (trigger.kind === "retry") return personOf(trigger.previousRunId, seen);
    if (!("entryId" in trigger)) return undefined;
    const woke = byId.get(trigger.entryId);
    if (woke?.type === "user.message") return woke.payload.authorId ?? creatorId;
    // A handoff or a bot's message answers whoever the run that sent it answered.
    return woke && "runId" in woke && woke.runId ? personOf(woke.runId, seen) : undefined;
  };

  for (const runId of starts.keys()) {
    const person = personOf(runId, new Set());
    if (person !== undefined && person !== viewerId) others.add(runId);
  }
  return others;
}
