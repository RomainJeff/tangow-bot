import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HoverPill } from "./hover-pill.js";

describe("HoverPill", () => {
  it("is hidden at rest and revealed by hover or keyboard focus on the row", () => {
    const html = renderToString(
      <HoverPill>
        <button type="button" aria-label="Reply" />
      </HoverPill>,
    );

    expect(html).toContain('data-slot="hover-pill"');
    // At rest: invisible and inert, so it never intercepts a click on the row.
    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    // Revealed by hover or keyboard focus, with no dependency on custom
    // pointer-media variants — a touch device never hovers, so it stays hidden.
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("group-hover:pointer-events-auto");
    // Keyboard focus only: a clicked button keeps focus, and must not pin it.
    expect(html).toContain("group-has-[:focus-visible]:opacity-100");
    expect(html).not.toContain("group-focus-within");
    expect(html).not.toContain("pointer-fine");
    expect(html).not.toContain("pointer-coarse");
  });

  it("floats at the end edge of the row", () => {
    const html = renderToString(<HoverPill>{null}</HoverPill>);

    expect(html).toContain("absolute");
    // Above the message body it is a previous sibling of, so clicks land.
    expect(html).toContain("z-10");
    expect(html).toContain("end-3");
    expect(html).toContain("rounded-full");
    expect(html).toContain("rk-glass-control");
    expect(html).not.toContain("right-");
  });

  it("moves next to the bubble when the row places it", () => {
    const html = renderToString(<HoverPill>{null}</HoverPill>);

    expect(html).toContain("group-data-[pill=beside]:start-(--pill-x)");
    expect(html).toContain("group-data-[pill=beside]:top-(--pill-y)");
    expect(html).toContain("group-data-[pill=beside]:end-auto");
  });

  it("spreads the remaining props onto its root", () => {
    const html = renderToString(<HoverPill data-testid="message-hover-actions">{null}</HoverPill>);
    expect(html).toContain('data-testid="message-hover-actions"');
  });
});
