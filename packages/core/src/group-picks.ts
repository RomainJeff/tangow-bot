/**
 * The panel's picks applied to the group as it is now: what was ticked or unticked since the panel
 * opened, so someone who left meanwhile is not added back by an unrelated save. Kept in the live
 * order, additions last, as the server orders a group's bots and people.
 */
export function applyPicks(
  live: readonly string[],
  opened: readonly string[],
  picked: readonly string[],
): string[] {
  return [
    ...live.filter((id) => !opened.includes(id) || picked.includes(id)),
    ...picked.filter((id) => !live.includes(id) && !opened.includes(id)),
  ];
}
