export function transcriptIsNearEnd(
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

/**
 * The scroll that shows the list's last row, from layout. A row moving on a transform still widens
 * scrollHeight, so while rows glide scrollHeight runs past the end and the browser pulls the scroll
 * back as they settle.
 */
export function transcriptEnd(element: HTMLElement): number {
  const max = element.scrollHeight - element.clientHeight;
  const last = element.lastElementChild;
  if (!(last instanceof HTMLElement) || !last.offsetParent) return max;
  const origin = last.offsetParent === element ? 0 : element.offsetTop + element.clientTop;
  const bottom =
    last.offsetTop -
    origin +
    last.offsetHeight +
    Number.parseFloat(getComputedStyle(last).marginBottom) +
    Number.parseFloat(getComputedStyle(element).paddingBottom);
  return Math.min(max, Math.max(0, bottom - element.clientHeight));
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

export function arrivedAfterMount(
  idsAtMount: ReadonlySet<string>,
  ids: readonly string[],
): Set<string> {
  const lastKnown = ids.findLastIndex((id) => idsAtMount.has(id));
  return new Set(ids.slice(lastKnown + 1));
}
