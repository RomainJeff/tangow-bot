/**
 * Column widths for a markdown table on a phone, sized to what each column
 * holds (how Notion and chat apps lay tables out): a column of numbers stays
 * narrow, a column of prose grows up to a cap and then wraps. Rows then keep
 * a sane height, and the table scrolls sideways once it is wider than its
 * bubble or card.
 */

/** Horizontal padding on each side of a cell. */
export const TABLE_CELL_PADDING_X = 10;
/** Narrowest column: a one-character value ("#", "5") and its padding. */
export const TABLE_COLUMN_MIN = 36;
/** Widest column: past this, a cell wraps instead of widening the table. */
export const TABLE_COLUMN_MAX = 220;
/** Average advance of a character in the 14 pt cell text. */
const CHAR_WIDTH = 7.4;

export interface TableNode {
  type: string;
  content?: string;
  children?: readonly TableNode[];
}

/** The text of a node and everything under it, formatting dropped. */
export function plainText(node: TableNode): string {
  const own = node.content ?? "";
  return node.children?.length ? own + node.children.map(plainText).join("") : own;
}

/** Every row of a table, header first, in order. */
export function tableRows(node: TableNode): TableNode[] {
  if (node.type === "tr") return [node];
  return (node.children ?? []).flatMap(tableRows);
}

/**
 * One width in points per column, from the longest cell of that column.
 * `fontScale` is the system text size (Dynamic Type), so columns grow with it.
 */
export function tableColumnWidths(
  table: TableNode,
  max: number = TABLE_COLUMN_MAX,
  fontScale = 1,
): number[] {
  const longest: number[] = [];
  for (const row of tableRows(table)) {
    const cells = (row.children ?? []).filter((cell) => cell.type === "th" || cell.type === "td");
    cells.forEach((cell, index) => {
      const length = plainText(cell).trim().length;
      longest[index] = Math.max(longest[index] ?? 0, length);
    });
  }
  return longest.map((length) =>
    Math.min(
      max,
      Math.max(
        TABLE_COLUMN_MIN,
        Math.round(length * CHAR_WIDTH * fontScale + TABLE_CELL_PADDING_X * 2),
      ),
    ),
  );
}
