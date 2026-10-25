export const DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP = 2;

type Part = { type?: unknown };
type PiAiMessage = { role: string; content?: unknown };

function images(message: PiAiMessage): number {
  if (!Array.isArray(message.content)) return 0;
  return message.content.filter((part: Part) => part.type === "image").length;
}

const toolResultImages = (message: PiAiMessage) =>
  message.role === "toolResult" ? images(message) : 0;

/**
 * Keeps the newest tool-result images, whichever tool returned them, within the model's image
 * budget less the images the user attached. Older ones go a full budget at a time, so the cached
 * prefix holds until the next block is due; a larger block would evict the newest image.
 */
export function prunePiAiImages<M extends PiAiMessage>(
  messages: readonly M[],
  maxImagesPerPrompt?: number,
): readonly M[] {
  const total = messages.reduce((count, message) => count + toolResultImages(message), 0);
  const attached =
    maxImagesPerPrompt === undefined
      ? 0
      : messages.reduce((count, message) => count + images(message), 0) - total;
  const keep = (maxImagesPerPrompt ?? DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP) - attached;
  if (keep < 0) {
    throw new Error(
      `The configured model image limit is ${maxImagesPerPrompt}, but the prompt contains ${attached} attached images.`,
    );
  }
  if (total <= keep) return messages;
  const block = Math.max(1, keep);
  let evict = Math.ceil((total - keep) / block) * block;
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
