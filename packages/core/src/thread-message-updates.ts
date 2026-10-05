/**
 * Folds a `thread.message.updated` event into the message a client already holds: the new role and
 * blocks (and reply fields when the event names them) replace the old ones, while author, run,
 * order (`seq`) and creation time stay those of the stored message. The event only describes the
 * rewrite, not the message's identity: its bot can be the thread's rather than the author's.
 * Undefined when the client does not hold the message (an older page it never loaded): the update
 * is then dropped rather than shown as a new message at the end of the thread.
 */
export function mergeMessageUpdate<
  Message extends {
    role: string;
    blocks: unknown[];
    replyToMessageId?: string | null;
    replyQuote?: string | null;
  },
>(existing: Message | undefined, update: Message): Message | undefined {
  if (!existing) return undefined;
  return {
    ...existing,
    role: update.role,
    blocks: update.blocks,
    ...(update.replyToMessageId ? { replyToMessageId: update.replyToMessageId } : {}),
    ...(update.replyQuote ? { replyQuote: update.replyQuote } : {}),
  };
}

/** Remove this run's live message and obsolete unscoped progress without reordering history. */
export function takeLiveMessage<Message extends { id: string; runId?: string | null }>(
  messages: readonly Message[],
  liveId: string,
): { previous: Message | undefined; remaining: Message[] } {
  let previous: Message | undefined;
  const remaining: Message[] = [];
  for (const message of messages) {
    if (message.id === liveId) previous = message;
    else if (!message.id.startsWith("progress:") || message.runId) remaining.push(message);
  }
  return { previous, remaining };
}
