import type { Bot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { botPageFor, pageBotOf, panelSizeFor, threadJumpLocation } from "./layout";

describe("panelSizeFor", () => {
  it("widens the bot panel for long text, routines, memory documents and skills only", () => {
    expect(panelSizeFor("bot", { tab: "settings", detail: { kind: "instructions" } })).toBe("wide");
    expect(panelSizeFor("bot", { tab: "settings", detail: { kind: "description" } })).toBe("wide");
    expect(
      panelSizeFor("bot", { tab: "routines", detail: { kind: "routine", routineId: "r" } }),
    ).toBe("wide");
    expect(panelSizeFor("bot", { tab: "routines", detail: { kind: "routine-new" } })).toBe("wide");
    expect(
      panelSizeFor("bot", { tab: "knowledge", detail: { kind: "memory", documentId: "d" } }),
    ).toBe("wide");
    expect(
      panelSizeFor("bot", { tab: "knowledge", detail: { kind: "skill", skillId: null } }),
    ).toBe("wide");
    expect(panelSizeFor("bot", { tab: "settings", detail: { kind: "model" } })).toBe("default");
    expect(panelSizeFor("bot", { tab: "settings", detail: null })).toBe("default");
  });

  it("keeps every other panel at the default width, whatever the bot page last showed", () => {
    const wideView = { tab: "settings" as const, detail: { kind: "instructions" as const } };
    expect(panelSizeFor("computer", wideView)).toBe("default");
    expect(panelSizeFor("group-settings", wideView)).toBe("default");
    expect(panelSizeFor(null, wideView)).toBe("default");
  });
});

describe("botPageFor", () => {
  it("opens the header on Activity and the settings entries on Settings", () => {
    expect(botPageFor("header")).toEqual({ tab: "activity", detail: null });
    expect(botPageFor("gear")).toEqual({ tab: "settings", detail: null });
    expect(botPageFor("menu")).toEqual({ tab: "settings", detail: null });
    expect(botPageFor("slash")).toEqual({ tab: "settings", detail: null });
  });

  it("opens the settings entries on Activity while the bot has no instructions", () => {
    const fresh = { instructions: "" };
    expect(botPageFor("gear", fresh)).toEqual({ tab: "activity", detail: null });
    expect(botPageFor("menu", fresh)).toEqual({ tab: "activity", detail: null });
    expect(botPageFor("slash", fresh)).toEqual({ tab: "activity", detail: null });
    expect(botPageFor("gear", { instructions: "Answer briefly." })).toEqual({
      tab: "settings",
      detail: null,
    });
  });
});

describe("threadJumpLocation", () => {
  it("lands a bot thread or a group thread on one message", () => {
    expect(threadJumpLocation({ botId: "bot-1", groupId: null, messageId: "m-1" })).toEqual({
      pathname: "/app/bot-1",
      search: "?m=m-1",
    });
    expect(threadJumpLocation({ botId: "bot-1", groupId: "g-1", messageId: "m-2" })).toEqual({
      pathname: "/app/g/g-1",
      search: "?m=m-2",
    });
    expect(threadJumpLocation({ botId: "bot-1", messageId: null })).toEqual({
      pathname: "/app/bot-1",
      search: undefined,
    });
  });

  it("carries the routine a search hit opens", () => {
    expect(threadJumpLocation({ botId: "bot-1", routineId: "r-1" })).toEqual({
      pathname: "/app/bot-1",
      search: "?routine=r-1",
    });
  });
});

describe("pageBotOf", () => {
  const bot = (id: string) => ({ id }) as Bot;
  const [alpha, beta, scout] = [bot("alpha"), bot("beta"), bot("scout")];

  it("shows the thread's bot until an archived bot is picked", () => {
    expect(pageBotOf(null, [alpha, beta], [scout], alpha)).toBe(alpha);
    expect(pageBotOf("scout", [alpha, beta], [scout], alpha)).toBe(scout);
  });

  it("keeps the picked bot once restored, and shows no page once it is deleted", () => {
    expect(pageBotOf("scout", [alpha, scout], [], alpha)).toBe(scout);
    expect(pageBotOf("scout", [alpha], [], alpha)).toBeUndefined();
  });
});
