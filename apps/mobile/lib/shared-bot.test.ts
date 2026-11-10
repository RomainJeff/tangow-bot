import { describe, expect, it, vi } from "vitest";
import type { MobileBot } from "./api.js";
import { computerScreenControls, rosterMuted, threadBotActions } from "./shared-bot.js";

const handlers = {
  openSettings: vi.fn(),
  share: vi.fn(),
  openComputer: vi.fn(),
  clear: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
};

describe("threadBotActions", () => {
  it("leaves a member only their own conversation on a bot shared with them", () => {
    expect(threadBotActions(true, handlers).map((action) => action.label)).toEqual([
      "Clear conversation",
    ]);
  });

  it("lets the owner share the bot from the thread title", () => {
    const share = threadBotActions(false, handlers).find((action) => action.label === "Share");
    share?.onPress();
    expect(handlers.share).toHaveBeenCalledOnce();
  });
});

describe("rosterMuted", () => {
  it("never reads a bot shared with you as muted", () => {
    const silenced = { notifyOnFinish: false } as MobileBot;
    expect(rosterMuted({ ...silenced, isOwner: false })).toBe(false);
    expect(rosterMuted({ ...silenced, isOwner: true })).toBe(true);
  });
});

describe("computerScreenControls", () => {
  const idle = { busyBotName: null, takeoverRequested: false };

  it("offers a member only the takeover their own run asks for", () => {
    expect(computerScreenControls(true, idle)).toEqual({ takeControl: false, modePicker: false });
    expect(computerScreenControls(true, { ...idle, takeoverRequested: true })).toEqual({
      takeControl: true,
      modePicker: false,
    });
  });

  it("keeps the owner's controls as they were", () => {
    expect(computerScreenControls(false, idle)).toEqual({ takeControl: true, modePicker: true });
    expect(computerScreenControls(false, { ...idle, busyBotName: "Notes" })).toMatchObject({
      takeControl: false,
    });
  });
});
