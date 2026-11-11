import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

import { avatarIdentitySeed } from "@tangow/core";
import {
  clearMainBotCache,
  loadMainBotCache,
  type MainBotCandidate,
  saveMainBotCache,
  selectMainBot,
} from "./main-bot-cache";

const bot = (over: Partial<MainBotCandidate>): MainBotCandidate => ({
  id: "bot-1",
  pinned: false,
  archivedAt: null,
  color: "#6F7FE8",
  shapeSeed: 2,
  ...over,
});

describe("selectMainBot", () => {
  it("picks the first pinned, non-archived bot in display order", () => {
    const bots = [
      bot({ color: "#111111", shapeSeed: 1 }),
      bot({ color: "#222222", shapeSeed: 2, pinned: true }),
      bot({ color: "#333333", shapeSeed: 3, pinned: true }),
    ];
    expect(selectMainBot(bots)).toEqual({ color: "#222222", shapeSeed: 2 });
  });

  it("falls back to the first non-archived bot when nothing is pinned", () => {
    const bots = [
      bot({ color: "#111111", shapeSeed: 1, archivedAt: "2026-01-01" }),
      bot({ color: "#222222", shapeSeed: 2 }),
    ];
    expect(selectMainBot(bots)).toEqual({ color: "#222222", shapeSeed: 2 });
  });

  it("skips archived bots even when pinned", () => {
    const bots = [
      bot({ color: "#111111", shapeSeed: 1, pinned: true, archivedAt: "2026-01-01" }),
      bot({ color: "#222222", shapeSeed: 2 }),
    ];
    expect(selectMainBot(bots)).toEqual({ color: "#222222", shapeSeed: 2 });
  });

  it("returns null when there is no candidate bot", () => {
    expect(selectMainBot([])).toBeNull();
    expect(selectMainBot([bot({ archivedAt: "2026-01-01" })])).toBeNull();
  });

  it("returns null when the only candidate has no shape yet", () => {
    expect(selectMainBot([bot({ shapeSeed: null })])).toEqual({
      color: "#6F7FE8",
      shapeSeed: avatarIdentitySeed("bot-1"),
    });
  });
});

describe("main bot cache persistence", () => {
  beforeEach(() => {
    store.clear();
  });

  it("saves and reloads the selected main bot", async () => {
    await saveMainBotCache([bot({ color: "#ABCDEF", shapeSeed: 5, pinned: true })]);
    await expect(loadMainBotCache()).resolves.toEqual({ color: "#ABCDEF", shapeSeed: 5 });
  });

  it("clears the cache when no bot qualifies", async () => {
    await saveMainBotCache([bot({ color: "#ABCDEF", shapeSeed: 5, pinned: true })]);
    await saveMainBotCache([]);
    await expect(loadMainBotCache()).resolves.toBeNull();
  });

  it("clears explicitly on sign-out", async () => {
    await saveMainBotCache([bot({ color: "#ABCDEF", shapeSeed: 5, pinned: true })]);
    await clearMainBotCache();
    await expect(loadMainBotCache()).resolves.toBeNull();
  });

  it("returns null instead of throwing on malformed stored data", async () => {
    store.set("rakazo.main_bot", "{not json");
    await expect(loadMainBotCache()).resolves.toBeNull();
  });
});
