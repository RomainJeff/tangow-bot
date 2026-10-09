import type { ThreadMessage } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { neverRan, panelSizeFor } from "./layout";

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

describe("neverRan", () => {
  const message = (runId?: string) => ({ id: "m", runId }) as ThreadMessage;

  it("counts a conversation with no run, or only a message seeded without one, as never run", () => {
    expect(neverRan({ messages: [], olderCursor: null, run: null })).toBe(true);
    expect(neverRan({ messages: [message()], olderCursor: null, run: null })).toBe(true);
  });

  it("counts a message a run wrote, a run under way or unread history as having run", () => {
    expect(
      neverRan({ messages: [message(), message("run-1")], olderCursor: null, run: null }),
    ).toBe(false);
    expect(neverRan({ messages: [], olderCursor: null, run: { id: "run-1" } as never })).toBe(
      false,
    );
    expect(neverRan({ messages: [message()], olderCursor: 3, run: null })).toBe(false);
  });
});
