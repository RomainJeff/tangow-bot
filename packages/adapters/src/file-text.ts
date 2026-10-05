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

export type LineWindow =
  | {
      ok: true;
      content: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      nextOffset?: number;
    }
  | { ok: false; error: "offset_out_of_range" | "line_too_long"; totalLines: number };

const encoder = new TextEncoder();

export function readLineWindow(
  content: string,
  window: { offset: number; limit?: number; maxBytes: number },
): LineWindow {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const totalLines = lines.length;
  const { offset, maxBytes } = window;
  if (offset > Math.max(totalLines, 1))
    return { ok: false, error: "offset_out_of_range", totalLines };

  const limit = window.limit ?? Number.POSITIVE_INFINITY;
  const taken: string[] = [];
  let bytes = 0;
  for (let index = offset - 1; index < totalLines && taken.length < limit; index++) {
    const line = lines[index] ?? "";
    const lineBytes = encoder.encode(line).byteLength;
    if (bytes + lineBytes > maxBytes) break;
    taken.push(line);
    bytes += lineBytes;
  }
  if (taken.length === 0 && offset <= totalLines) {
    return { ok: false, error: "line_too_long", totalLines };
  }
  const endLine = offset - 1 + taken.length;
  return {
    ok: true,
    content: taken.join(""),
    startLine: offset,
    endLine,
    totalLines,
    ...(endLine < totalLines ? { nextOffset: endLine + 1 } : {}),
  };
}
