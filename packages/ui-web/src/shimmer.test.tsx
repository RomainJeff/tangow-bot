import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Shimmer } from "./shimmer.js";

describe("Shimmer", () => {
  it("sweeps a label with one token-driven class", () => {
    const html = renderToString(<Shimmer>Drafting the recap</Shimmer>);

    expect(html).toContain('data-slot="shimmer"');
    expect(html).toContain("rk-shimmer");
    expect(html).toContain("Drafting the recap");
  });

  it("spreads the remaining props onto its root", () => {
    const html = renderToString(<Shimmer data-testid="live-step">Drafting</Shimmer>);
    expect(html).toContain('data-testid="live-step"');
  });
});
