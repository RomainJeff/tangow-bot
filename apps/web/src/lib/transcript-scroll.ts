export function transcriptIsNearEnd(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

export function transcriptCanSnapAfterFrame(
  element: Pick<HTMLElement, "scrollTop"> | null,
  queuedElement: Pick<HTMLElement, "scrollTop">,
  queuedScrollTop: number,
): boolean {
  return element === queuedElement && queuedElement.scrollTop === queuedScrollTop;
}

export function transcriptMovedDown(previousScrollTop: number | null, scrollTop: number): boolean {
  return previousScrollTop !== null && scrollTop >= previousScrollTop;
}

/**
 * B9: the rows that arrived after a `Transcript` mounted, which play the arrival beat. A row is
 * new when its id was absent at mount and it sits after the last row that was there: the first
 * load, a reopened thread and a "Load earlier messages" page all land at or before that row.
 */
export function arrivedAfterMount(
  idsAtMount: ReadonlySet<string>,
  ids: readonly string[],
): Set<string> {
  const lastKnown = ids.findLastIndex((id) => idsAtMount.has(id));
  return new Set(ids.slice(lastKnown + 1).filter((id) => !idsAtMount.has(id)));
}
