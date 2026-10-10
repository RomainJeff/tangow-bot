/**
 * The SKILL.md field holds a draft only while someone edits it (`draft` is null otherwise), so
 * the field can never show or save a text the server no longer holds.
 */
export function skillText(content: string | null, draft: string | null): string {
  return draft ?? content ?? "";
}

export function skillDirty(content: string | null, draft: string | null): boolean {
  return draft !== null && content !== null && draft !== content;
}
