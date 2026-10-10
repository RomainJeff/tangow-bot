const MAX_PREVIEW_WORDS = 12;

/** The first words of a conversation's preview, which the server already sends as plain text. */
export function previewSnippet(preview: string, maxWords = MAX_PREVIEW_WORDS): string {
  return preview.split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
}
