import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Surface } from "./surface.js";

describe("Surface", () => {
  it("sits on the bot's paper without lifting", () => {
    const html = renderToString(<Surface>card</Surface>);
    expect(html).toContain('data-variant="default"');
    expect(html).toContain("bg-chat-bot");
    expect(html).toContain("shadow-bubble");
    expect(html).not.toContain("shadow-card");
  });

  it("renders the requested element", () => {
    const html = renderToString(<Surface as="section">table</Surface>);
    expect(html).toContain("<section");
  });

  it("trades the paper's edge for the outline ring when outlined", () => {
    const html = renderToString(<Surface variant="outlined">task</Surface>);
    expect(html).toContain('data-variant="outlined"');
    expect(html).toContain("ring-outline");
    expect(html).not.toContain("shadow-bubble");
  });
});
