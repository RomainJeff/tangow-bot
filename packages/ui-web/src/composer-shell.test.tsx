import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerShell } from "./composer-shell.js";

describe("ComposerShell", () => {
  it("is a capsule with the composer elevation", () => {
    const html = renderToString(
      <ComposerShell trailing={<button type="button" aria-label="Send" />}>
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain('data-slot="composer-shell"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("rounded-composer");
    expect(html).toContain("bg-surface");
    expect(html).toContain("shadow-composer");
    expect(html).toContain("ps-4");
  });

  it("carries a quiet focus-within ring for keeping keyboard focus visible", () => {
    const html = renderToString(
      <ComposerShell trailing={<button type="button" aria-label="Send" />}>
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain("focus-within:ring-border");
  });

  it("is a ref-forwarding component named ComposerShell", () => {
    expect(ComposerShell.displayName).toBe("ComposerShell");
  });

  it("tightens the leading padding when a chip sits in front", () => {
    const html = renderToString(
      <ComposerShell leading={<span>chip</span>}>
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );
    expect(html).toContain("ps-2.5");
    expect(html).not.toContain("ps-4");
  });

  it("shows four bars while dictating and nothing else", () => {
    const html = renderToString(
      <ComposerShell state="dictating">
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain('data-state="dictating"');
    expect(html).toContain('data-slot="composer-dictating"');
    expect(html.match(/rk-bar/g)).toHaveLength(4);
    expect(html).not.toContain('data-slot="composer-working"');
  });

  it("shows three dots while the run is going", () => {
    const html = renderToString(
      <ComposerShell state="working">
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain('data-state="working"');
    expect(html.match(/rk-dot/g)).toHaveLength(3);
    expect(html).not.toContain('data-slot="composer-dictating"');
  });

  it("leaves the speaking beat to the caller's slots", () => {
    const html = renderToString(
      <ComposerShell state="speaking" leading={<span>avatar</span>}>
        <span>Maya is speaking</span>
      </ComposerShell>,
    );

    expect(html).toContain('data-state="speaking"');
    expect(html).not.toContain("rk-bar");
    expect(html).not.toContain("rk-dot");
  });

  it("spreads the remaining props onto its root", () => {
    const html = renderToString(
      <ComposerShell data-testid="composer-bar" id="composer">
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain('data-testid="composer-bar"');
    expect(html).toContain('id="composer"');
  });
});
