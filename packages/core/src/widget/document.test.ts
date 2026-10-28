import { describe, expect, it } from "vitest";
import { buildWidgetDocument, parseWidgetHeightMessage } from "./document.js";

describe("widget document", () => {
  it("puts the restrictive CSP before any supplied markup, scripts or styles", () => {
    const html = '<meta name="attacker"><script>fetch("https://example.test")</script>';
    const document = buildWidgetDocument({ html, theme: "light" });
    const head = document.slice(document.indexOf("<head>") + 6);
    expect(head).toMatch(/^<meta http-equiv="Content-Security-Policy"/);
    expect(head.slice(0, head.indexOf("><meta name="))).toContain(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; media-src https: data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    );
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf(html));
    expect(document).toContain('<html data-theme="light">');
    expect(document).toContain('<base target="_blank">');
  });

  it("accepts only finite positive height messages encoded as JSON strings", () => {
    expect(parseWidgetHeightMessage('{"rakazoWidgetHeight":215}')).toBe(215);
    for (const message of [
      null,
      {},
      "invalid",
      "null",
      '{"rakazoWidgetHeight":0}',
      '{"rakazoWidgetHeight":-2}',
      '{"rakazoWidgetHeight":"20"}',
      '{"rakazoWidgetHeight":1e999}',
    ]) {
      expect(parseWidgetHeightMessage(message)).toBeNull();
    }
  });
});
