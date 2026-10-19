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

/** "space · collection · bot" line under a memory title. */
export function memoryLocation(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(" · ");
}
