import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnBotEditTarget } from "./spawn-bot-edit";
import {
  closeSpawnBotEdit,
  openSpawnBotEdit,
  spawnBotEditTarget,
  subscribeSpawnBotEdit,
  syncSpawnBotEdit,
} from "./spawn-bot-edit";

const spawnBot: SpawnBotEditTarget["spawnBot"] = {
  name: "Veille",
  title: "Veille concurrentielle",
  instructions: "Watch competitors.",
  prompt: "Start on the assigned work.",
  computerMode: "dedicated",
};

function target(messageId = "msg-1"): SpawnBotEditTarget {
  return { messageId, spawnBot, submit: vi.fn(async () => undefined) };
}

afterEach(() => {
  const open = spawnBotEditTarget();
  if (open) closeSpawnBotEdit(open.messageId);
});

describe("spawn bot edit registry", () => {
  it("has no content until a card opens it, so a sheet reached by a link closes", () => {
    expect(spawnBotEditTarget()).toBeNull();
  });

  it("opens the sheet route and serves the card's content", () => {
    const router = { push: vi.fn() };
    const opened = target();
    openSpawnBotEdit(router, opened);
    expect(router.push).toHaveBeenCalledWith("/edit-bot-proposal");
    expect(spawnBotEditTarget()).toBe(opened);
  });

  it("notifies subscribers when the content appears and when it is cleared", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSpawnBotEdit(listener);
    openSpawnBotEdit({ push: vi.fn() }, target());
    expect(listener).toHaveBeenCalledTimes(1);
    closeSpawnBotEdit("msg-1");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    openSpawnBotEdit({ push: vi.fn() }, target());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("only clears the content of the message it is asked about", () => {
    openSpawnBotEdit({ push: vi.fn() }, target("msg-1"));
    closeSpawnBotEdit("msg-other");
    expect(spawnBotEditTarget()?.messageId).toBe("msg-1");
    closeSpawnBotEdit("msg-1");
    expect(spawnBotEditTarget()).toBeNull();
  });

  it("is cleared when the card is answered elsewhere or is no longer the answerable one", () => {
    openSpawnBotEdit({ push: vi.fn() }, target("msg-1"));
    syncSpawnBotEdit("msg-1");
    expect(spawnBotEditTarget()).not.toBeNull();
    syncSpawnBotEdit(null);
    expect(spawnBotEditTarget()).toBeNull();

    openSpawnBotEdit({ push: vi.fn() }, target("msg-1"));
    syncSpawnBotEdit("msg-2");
    expect(spawnBotEditTarget()).toBeNull();
  });
});
