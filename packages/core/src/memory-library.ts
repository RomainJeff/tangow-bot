/** Input for `memory.library.capture`; the key makes a repeated Remember return the same memory. */
export function memoryCaptureInput(
  messageId: string,
  botId?: string,
): { messageId: string; botId?: string; idempotencyKey: string } {
  return {
    messageId,
    ...(botId ? { botId } : {}),
    idempotencyKey: `capture:${botId ?? "space"}:${messageId}`,
  };
}

/** Annotations arrive newest first; keep each bot's latest judgment. */
export function latestAnnotationPerBot<T extends { bot: { id: string } }>(annotations: T[]): T[] {
  const seen = new Set<string>();
  return annotations.filter((item) => !seen.has(item.bot.id) && !!seen.add(item.bot.id));
}

/** "space · collection · bot" line under a memory title. */
export function memoryLocation(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(" · ");
}
