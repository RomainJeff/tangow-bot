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
 * B9 (web-parity PR B): the highest `seq` among a thread's messages at the
 * moment a `Transcript` mounts — the line below which a message is history,
 * however it got there (the thread's first load, a page already fully
 * fetched before mount, or a "Load earlier messages" prepend afterwards),
 * never a genuinely new arrival that should play the arrival beat.
 * Reopening an already-loaded thread mounts a fresh `Transcript` with its
 * full history already in `messages` (Shell keys it by `threadId` and
 * commits a snapshot atomically — never a partial page first), so this line
 * sits at or above every one of them: none can cross it.
 */
export function initialMaxSeq(messages: readonly { seq?: number | null }[]): number {
  return messages.reduce((max, message) => Math.max(max, message.seq ?? 0), 0);
}

/** A message is a new arrival only once its `seq` passes the line captured
 * at mount (`initialMaxSeq`). */
export function isNewArrivalSeq(
  messageSeq: number | null | undefined,
  maxSeqAtMount: number,
): boolean {
  return (messageSeq ?? 0) > maxSeqAtMount;
}
