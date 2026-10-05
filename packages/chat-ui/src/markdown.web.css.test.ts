import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// B7 (web-parity PR B): a many-column table in a narrow bot bubble (e.g. 6
// columns at 390px) must scroll horizontally rather than shrinking every
// column down to one letter per line. That needs a real per-cell floor width —
// without it, the table's own `overflow-x: auto` never triggers because the
// browser's table auto-layout shrinks columns to fit the bubble first.
describe("markdown.web.css table cells", () => {
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "markdown.web.css"),
    "utf8",
  );

  it("keeps the table scrollable instead of letting it shrink to fit", () => {
    const tableRule = css.match(/\.rk-chat-markdown table\s*{[^}]*}/)?.[0] ?? "";
    expect(tableRule).toContain("overflow-x: auto");
    expect(tableRule).toContain("max-width: 100%");
  });

  it("gives every header and data cell a floor width so columns cannot collapse", () => {
    const cellRule =
      css.match(/\.rk-chat-markdown th,\s*\n\.rk-chat-markdown td\s*{[^}]*}/)?.[0] ?? "";
    expect(cellRule).toMatch(/min-width:\s*\S+/);
    expect(cellRule).toContain("overflow-wrap: break-word");
  });
});
