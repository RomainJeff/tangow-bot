import { createSaveStore, saveKey } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { claimSaveAnnouncement } from "./save-announce";

const scope = { userId: "user-1", spaceId: "space-1" };

describe("save announcements", () => {
  it("speaks each outcome once, however many metas show it, and again after a new attempt", async () => {
    const store = createSaveStore();
    const key = saveKey(scope, "bot-1", "notifyOnFinish");
    let online = false;
    const commit = async () => {
      if (!online) throw new Error("offline");
    };

    await store.save(key, true, commit);
    expect(claimSaveAnnouncement(store.state(key))).toBe(true);
    expect(claimSaveAnnouncement(store.state(key))).toBe(false);

    online = true;
    const retrying = store.retry(key);
    expect(claimSaveAnnouncement(store.state(key))).toBe(false);
    await retrying;
    expect(store.state(key).kind).toBe("saved");
    expect(claimSaveAnnouncement(store.state(key))).toBe(true);
    expect(claimSaveAnnouncement(store.state(key))).toBe(false);
  });

  it("speaks two fields that fail together separately", async () => {
    const store = createSaveStore();
    const name = saveKey(scope, "bot-1", "name");
    const title = saveKey(scope, "bot-1", "title");
    const fail = async () => {
      throw new Error("offline");
    };
    await Promise.all([store.save(name, "Scout 2", fail), store.save(title, "Reads", fail)]);
    expect(claimSaveAnnouncement(store.state(name))).toBe(true);
    expect(claimSaveAnnouncement(store.state(title))).toBe(true);
  });
});
