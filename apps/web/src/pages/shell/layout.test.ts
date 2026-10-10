import { describe, expect, it } from "vitest";
import { panelSizeFor } from "./layout";

describe("panelSizeFor", () => {
  it("widens the bot panel for instructions and the description only", () => {
    expect(panelSizeFor("bot", { tab: "settings", detail: { kind: "instructions" } })).toBe("wide");
    expect(panelSizeFor("bot", { tab: "settings", detail: { kind: "description" } })).toBe("wide");
    expect(panelSizeFor("bot", { tab: "settings", detail: { kind: "model" } })).toBe("default");
    expect(panelSizeFor("bot", { tab: "settings", detail: null })).toBe("default");
  });

  it("keeps every other panel at the default width, whatever the bot page last showed", () => {
    const wideView = { tab: "settings" as const, detail: { kind: "instructions" as const } };
    expect(panelSizeFor("computer", wideView)).toBe("default");
    expect(panelSizeFor("routine", wideView)).toBe("default");
    expect(panelSizeFor(null, wideView)).toBe("default");
  });
});
