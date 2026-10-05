export type TextEditResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; error: "not_found" | "ambiguous" | "empty_old_text"; matches?: number };

export function applyTextEdit(
  content: string,
  edit: { oldText: string; newText: string; replaceAll: boolean },
): TextEditResult {
  if (edit.oldText === "") return { ok: false, error: "empty_old_text" };
  const parts = content.split(edit.oldText);
  const matches = parts.length - 1;
  if (matches === 0) return { ok: false, error: "not_found" };
  if (matches > 1 && !edit.replaceAll) return { ok: false, error: "ambiguous", matches };
  if (edit.replaceAll) {
    return { ok: true, content: parts.join(edit.newText), replacements: matches };
  }
  return {
    ok: true,
    content: `${parts[0]}${edit.newText}${parts[1]}`,
    replacements: 1,
  };
}
