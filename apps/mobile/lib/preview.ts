import { plainText } from "@rakazo/core";

const MAX_PREVIEW_WORDS = 12;

export function previewSnippet(markdown: string, maxWords = MAX_PREVIEW_WORDS): string {
  const words = plainText(markdown).split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}
