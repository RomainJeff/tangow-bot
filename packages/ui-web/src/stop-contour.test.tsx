import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StopContour } from "./stop-contour.js";

describe("StopContour", () => {
  it("is aria-hidden chrome with no copy of its own", () => {
    const html = renderToString(<StopContour color="#E0714F" />);

    expect(html).toContain('data-slot="stop-contour"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("rk-stop-contour");
  });

  it("carries the bot's colour for each theme as CSS custom properties", () => {
    const html = renderToString(<StopContour color="#E0714F" />);
    expect(html).toContain("--contour-light:#E0714F");
    expect(html).toContain("--contour-dark:#E0714F");
  });

  it("dims the contour in the theme where the bot colour would not read", () => {
    const html = renderToString(<StopContour color="#17181A" />);
    expect(html).toContain("--contour-light:#17181A");
    expect(html).toContain("--contour-dark:color-mix(in srgb, var(--foreground) 45%, transparent)");
  });

  it("falls back to a dim foreground when no bot colour is known", () => {
    const html = renderToString(<StopContour />);
    expect(html).toContain("color-mix(in srgb, var(--foreground) 45%, transparent)");
  });

  it("draws the primary disc and its small square, both inside the ring", () => {
    const html = renderToString(<StopContour color="#E0714F" />);
    expect(html).toContain("bg-primary");
    expect(html).toContain("bg-primary-foreground");
  });

  it("merges a caller className onto the root", () => {
    const html = renderToString(<StopContour color="#E0714F" className="custom-class" />);
    expect(html).toContain("custom-class");
  });
});
