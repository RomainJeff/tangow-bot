import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkingLine } from "./working-line.js";

describe("WorkingLine", () => {
  it("announces what the bot is doing, with a monospaced duration", () => {
    const html = renderToString(
      <WorkingLine avatar={<span>avatar</span>} label="Maya is drafting the recap" />,
    );

    expect(html).toContain('data-slot="working-line"');
    expect(html).toContain('role="status"');
    expect(html).toContain("text-working");
    expect(html).toContain("font-mono");
    expect(html).toContain("text-mono");
    expect(html).toContain("tabular-nums");
    expect(html).toContain("Maya is drafting the recap");
    // The avatar gets its own reserved column, next to the label.
    expect(html).toContain("w-message");
  });

  it("cuts a long label with an ellipsis instead of widening the page", () => {
    const html = renderToString(
      <WorkingLine
        avatar={<span>avatar</span>}
        label={`Searching the web: ${"Club Med OR ".repeat(20)}`}
      />,
    );
    // The root must be allowed to shrink inside a flex row, or `truncate` never applies.
    expect(html).toMatch(/data-slot="working-line"[^>]*class="[^"]*min-w-0[^"]*max-w-full/);
    expect(html).toMatch(/class="[^"]*min-w-0 truncate[^"]*"/);
    expect(html).toMatch(
      /class="shrink-0 [^"]*"[^>]*data-slot="working-line-elapsed"|data-slot="working-line-elapsed"[^>]*class="shrink-0/,
    );
  });

  it("skips the avatar column entirely when there is no avatar", () => {
    const html = renderToString(<WorkingLine label="Reconnecting" />);
    expect(html).not.toContain("w-message");
  });

  it("keeps the ticking duration out of the announcement", () => {
    const html = renderToString(<WorkingLine avatar={null} label="working" startedAt={0} />);
    expect(html).toMatch(/aria-hidden="true"[^>]*data-slot="working-line-elapsed"/);
  });

  it("spreads the remaining props onto its root", () => {
    const html = renderToString(
      <WorkingLine avatar={null} label="working" data-testid="progress-message" />,
    );
    expect(html).toContain('data-testid="progress-message"');
  });
});
