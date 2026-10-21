import { DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP } from "../../pi-runtime.js";

type Part = { type?: unknown };

function toolResultImages(message: { role: string; content?: unknown }): number {
  if (message.role !== "toolResult" || !Array.isArray(message.content)) return 0;
  return message.content.filter((part: Part) => part.type === "image").length;
}

/**
 * Keeps at most the newest `maxImages` tool-result images, whichever tool returned them. Older ones
 * go `maxImages` at a time, so the cached prefix holds until the next block is due; a larger block
 * would evict the newest image.
 */
export function prunePiAiImages<M extends { role: string; content?: unknown }>(
  messages: readonly M[],
  maxImages = DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP,
): readonly M[] {
  const total = messages.reduce((count, message) => count + toolResultImages(message), 0);
  if (total <= maxImages) return messages;
  const block = Math.max(1, maxImages);
  let evict = Math.ceil((total - maxImages) / block) * block;
  return messages.map((message) => {
    if (evict === 0 || toolResultImages(message) === 0) return message;
    const content = (message.content as Part[]).filter((part) => {
      if (part.type !== "image" || evict === 0) return true;
      evict -= 1;
      return false;
    });
    return { ...message, content };
  });
}
