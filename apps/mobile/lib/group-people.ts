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
