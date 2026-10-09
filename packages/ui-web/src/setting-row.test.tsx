import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingRow } from "./setting-row.js";

describe("SettingRow", () => {
  it("is a static row by default: label, sub-line and a trailing control", () => {
    const html = renderToString(
      <SettingRow label="Notify me" subline="When a run finishes">
        <button type="button">control</button>
      </SettingRow>,
    );
    expect(html).toMatch(/^<div data-slot="setting-row"/);
    expect(html).toContain('data-slot="setting-row-label"');
    expect(html).toContain("Notify me");
    expect(html).toContain('data-slot="setting-row-subline"');
    expect(html).toContain("When a run finishes");
    expect(html).toContain('data-slot="setting-row-trailing"');
    expect(html).toContain('<button type="button">control</button>');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("hover:bg-accent");
  });

  it("leaves out the sub-line and the trailing side when there is none", () => {
    const html = renderToString(<SettingRow label="Name" />);
    expect(html).not.toContain("setting-row-subline");
    expect(html).not.toContain("setting-row-trailing");
  });

  it("puts the meta ahead of the trailing control", () => {
    const html = renderToString(
      <SettingRow label="Active" meta={<span>META</span>}>
        <span>CONTROL</span>
      </SettingRow>,
    );
    expect(html.indexOf("META")).toBeGreaterThan(html.indexOf("Active"));
    expect(html.indexOf("META")).toBeLessThan(html.indexOf("CONTROL"));
  });

  it("is a button with a chevron when it opens something", () => {
    const html = renderToString(
      <SettingRow label="Model" subline="Auto" onClick={() => {}} chevron />,
    );
    expect(html).toMatch(/^<button type="button" data-slot="setting-row"/);
    expect(html).toContain("hover:bg-accent");
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
  });

  it("merges className and spreads native props", () => {
    const html = renderToString(
      <SettingRow label="Voice" className="py-0" data-testid="voice-row" aria-disabled="true" />,
    );
    expect(html).toContain('data-testid="voice-row"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("py-0");
    expect(html).not.toContain("py-2.5");
  });
});
