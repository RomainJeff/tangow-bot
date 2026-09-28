import { describe, expect, it } from "vitest";
import type { TableNode } from "./table-layout.js";
import { TABLE_COLUMN_MAX, TABLE_COLUMN_MIN, tableColumnWidths } from "./table-layout.js";

function text(content: string): TableNode {
  return { type: "text", content };
}

function row(kind: "th" | "td", ...cells: string[]): TableNode {
  return { type: "tr", children: cells.map((cell) => ({ type: kind, children: [text(cell)] })) };
}

function table(...rows: TableNode[]): TableNode {
  return {
    type: "table",
    children: [
      { type: "thead", children: rows.slice(0, 1) },
      { type: "tbody", children: rows.slice(1) },
    ],
  };
}

describe("tableColumnWidths", () => {
  it("keeps a column of short values narrow and lets a prose column grow to the cap", () => {
    const widths = tableColumnWidths(
      table(
        row("th", "#", "Option"),
        row("td", "1", "Club Med La Palmyre, voiture ~5h, Baby Club dès 4 mois inclus"),
        row("td", "2", "Club Med Opio en Provence"),
      ),
    );

    expect(widths[0]).toBe(TABLE_COLUMN_MIN);
    expect(widths[1]).toBe(TABLE_COLUMN_MAX);
  });

  it("sizes a mid-length column between the floor and the cap", () => {
    const [width] = tableColumnWidths(table(row("th", "Prix"), row("td", "2 088 €")));

    expect(width).toBeGreaterThan(TABLE_COLUMN_MIN - 1);
    expect(width).toBeLessThan(TABLE_COLUMN_MAX);
  });

  it("reads the text inside formatted cells", () => {
    const bold: TableNode = {
      type: "tr",
      children: [
        { type: "td", children: [{ type: "strong", children: [text("Village Clubs du Soleil")] }] },
      ],
    };
    const [width] = tableColumnWidths(table(row("th", "x"), bold));

    expect(width).toBeGreaterThan(150);
  });
});

describe("tableColumnWidths with a larger system text size", () => {
  it("widens columns as text grows", () => {
    const node = table(row("th", "Prix"), row("td", "2 088 €"));
    const [regular] = tableColumnWidths(node);
    const [large] = tableColumnWidths(node, undefined, 1.5);

    expect(large).toBeGreaterThan(regular ?? 0);
  });
});
