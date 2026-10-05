import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerShell } from "./composer-shell.js";

describe("ComposerShell", () => {
  it("is a capsule with the composer elevation, bottom-aligned, at least 48px tall", () => {
    const html = renderToString(
      <ComposerShell trailing={<button type="button" aria-label="Send" />}>
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain('data-slot="composer-shell"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("rounded-composer");
    expect(html).toContain("bg-surface");
    expect(html).toContain("shadow-composer-rest");
    expect(html).toContain("min-h-12");
    expect(html).toContain("items-end");
  });

  it("rests on a hairline and lifts to the focus elevation while its field has focus", () => {
    const html = renderToString(
      <ComposerShell trailing={<button type="button" aria-label="Send" />}>
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain("focus-within:shadow-composer-focus");
  });

  it("is a ref-forwarding component named ComposerShell", () => {
    expect(ComposerShell.displayName).toBe("ComposerShell");
  });

  it("puts attach before the chip before the field", () => {
    const html = renderToString(
      <ComposerShell
        attach={<button type="button" aria-label="Attach file" data-testid="attach" />}
        leading={<span data-testid="chip">chip</span>}
      >
        <textarea aria-label="Message Maya" data-testid="field" />
      </ComposerShell>,
    );

    const attachIndex = html.indexOf('data-testid="attach"');
    const chipIndex = html.indexOf('data-testid="chip"');
    const fieldIndex = html.indexOf('data-testid="field"');
    expect(attachIndex).toBeGreaterThan(-1);
    expect(attachIndex).toBeLessThan(chipIndex);
    expect(chipIndex).toBeLessThan(fieldIndex);
  });

  it("renders the attachments slot above the input line", () => {
    const html = renderToString(
      <ComposerShell attachments={<span data-testid="thumb">thumb</span>}>
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain('data-slot="composer-attachments"');
    const attachmentsIndex = html.indexOf('data-slot="composer-attachments"');
    const fieldIndex = html.indexOf('data-slot="composer-shell-field"');
    expect(attachmentsIndex).toBeLessThan(fieldIndex);
  });

  it("omits the attachments slot when there is nothing pending", () => {
    const html = renderToString(
      <ComposerShell>
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).not.toContain('data-slot="composer-attachments"');
  });

  it("draws a foreground outline instead of the ambient shadow while dictating", () => {
    const html = renderToString(
      <ComposerShell state="dictating">
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain('data-state="dictating"');
    expect(html).toContain("ring-foreground");
    expect(html).not.toContain("shadow-composer-rest");
  });

  it("uses a token-backed ring width, no arbitrary Tailwind value", () => {
    const html = renderToString(
      <ComposerShell state="dictating">
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain("ring-2");
    expect(html).not.toMatch(/ring-\[/);
  });

  it("only transitions the shadow when motion is safe, never unconditionally", () => {
    const html = renderToString(
      <ComposerShell>
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain("motion-safe:transition-shadow");
    expect(html).not.toMatch(/(?<!motion-safe:)transition-shadow/);
  });

  it("shows a ×/waveform/✓ row under the field while dictating, four bars and nothing else", () => {
    const html = renderToString(
      <ComposerShell
        state="dictating"
        dictationCancel={<button type="button" aria-label="Cancel dictation" />}
        dictationConfirm={<button type="button" aria-label="Insert dictation" />}
      >
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).toContain('data-slot="composer-dictation-controls"');
    expect(html).toContain('data-slot="composer-dictating"');
    expect(html.match(/rk-bar/g)).toHaveLength(4);
    expect(html).toContain("Cancel dictation");
    expect(html).toContain("Insert dictation");
    const controlsIndex = html.indexOf('data-slot="composer-dictation-controls"');
    const cancelIndex = html.indexOf("Cancel dictation");
    const barsIndex = html.indexOf('data-slot="composer-dictating"');
    const confirmIndex = html.indexOf("Insert dictation");
    expect(controlsIndex).toBeLessThan(cancelIndex);
    expect(cancelIndex).toBeLessThan(barsIndex);
    expect(barsIndex).toBeLessThan(confirmIndex);
  });

  it("omits the dictation controls row outside dictating state", () => {
    const html = renderToString(
      <ComposerShell
        state="typing"
        dictationCancel={<button type="button" aria-label="Cancel dictation" />}
        dictationConfirm={<button type="button" aria-label="Insert dictation" />}
      >
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).not.toContain('data-slot="composer-dictation-controls"');
  });

  it("has no working-dots state — the Stop contour carries that signal instead", () => {
    const html = renderToString(
      <ComposerShell state="typing">
        <textarea aria-label="Message Maya" />
      </ComposerShell>,
    );

    expect(html).not.toContain("composer-working");
    expect(html).not.toContain("rk-dot");
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
