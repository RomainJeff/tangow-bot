import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Surface } from "./surface.js";

describe("Surface", () => {
  it("is a fill and a hairline, never a shadow", () => {
    const html = renderToString(<Surface>card</Surface>);

    expect(html).toContain('data-slot="surface"');
    expect(html).toContain('data-radius="card"');
    expect(html).toContain("rounded-card");
    expect(html).toContain("bg-surface");
    expect(html).toContain("border-border");
    expect(html).not.toContain("shadow-");
  });

  it("matches a framed block at the block radius", () => {
    const html = renderToString(<Surface radius="block">block</Surface>);
    expect(html).toContain('data-radius="block"');
    expect(html).toContain("rounded-block");
    expect(html).not.toContain("rounded-card");
  });

  it("renders the requested element", () => {
    const html = renderToString(<Surface as="section">table</Surface>);
    expect(html).toContain("<section");
  });

  it("trades the hairline for the outline edge when outlined", () => {
    const html = renderToString(<Surface variant="outlined">task</Surface>);
    expect(html).toContain('data-variant="outlined"');
    expect(html).toContain("border-outline");
    expect(html).not.toContain("border-border");
  });

  it("keeps the hairline by default", () => {
    const html = renderToString(<Surface>card</Surface>);
    expect(html).toContain('data-variant="default"');
    expect(html).toContain("border-border");
    expect(html).not.toContain("border-outline");
  });
});
