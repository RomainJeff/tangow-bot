import type { ComputerUpdate } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComputerUpdates } from "./computer-updates.js";

const update: ComputerUpdate = {
  id: "update-1",
  botId: "bot-1",
  name: "Writer",
  mode: "team",
  action: "update",
  status: "running",
  stage: "saving",
};
afterEach(() => vi.useRealTimers());
describe("computer update presentation", () => {
  it("keeps a newly started update when an older poll returns, and closing does not stop polling", async () => {
    vi.useFakeTimers();
    let resolve!: (rows: ComputerUpdate[]) => void;
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((done) => {
          resolve = done;
        }),
    );
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
      releaseInterrupted: async () => {},
    });
    const stop = store.watch();
    await store.start("bot-1");
    resolve([]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({ updates: [update], openId: update.id });
    store.open(null);
    await vi.advanceTimersByTimeAsync(1500);
    resolve([{ ...update, stage: "restoring" }]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({
      updates: [{ ...update, stage: "restoring" }],
      openId: null,
    });
    stop();
  });
  it("restores background progress on a new mount and ignores responses after disposal", async () => {
    vi.useFakeTimers();
    const store = createComputerUpdates({
      list: async () => [update],
      start: async () => update,
      dismiss: async () => {},
      releaseInterrupted: async () => {},
    });
    let stop = store.watch();
    await Promise.resolve();
    expect(store.getSnapshot().updates).toEqual([update]);
    stop();
    stop = store.watch();
    stop();
    await Promise.resolve();
    expect(store.getSnapshot().updates).toEqual([]);
  });
  it("keeps an authoritative completed result open until Done without dismissing its server history", async () => {
    vi.useFakeTimers();
    const completed: ComputerUpdate = { ...update, status: "completed", stage: "reconnecting" };
    const dismiss = vi.fn(async () => {});
    const requests: string[][] = [];
    const store = createComputerUpdates({
      list: async (ids: string[]) => {
        requests.push(ids);
        return ids.includes(update.id) ? [completed] : [];
      },
      start: async () => update,
      dismiss,
      releaseInterrupted: async () => {},
    });
    const stop = store.watch();
    await store.start("bot-1");
    await vi.advanceTimersByTimeAsync(1500);
    expect(store.getSnapshot()).toEqual({ updates: [completed], openId: update.id });
    const calls = requests.length;
    await vi.advanceTimersByTimeAsync(14999);
    expect(requests).toHaveLength(calls);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests.at(-1)).toEqual([update.id]);
    await store.dismiss(update.id);
    expect(dismiss).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({ updates: [], openId: null });
    stop();
  });

  it("tracks batch receipts before reading a result that already completed", async () => {
    vi.useFakeTimers();
    const completed: ComputerUpdate = { ...update, status: "completed", stage: "reconnecting" };
    const store = createComputerUpdates({
      list: async (ids: string[]) => (ids.includes(update.id) ? [completed] : []),
      start: async () => update,
      dismiss: async () => {},
      releaseInterrupted: async () => {},
    });
    const stop = store.watch();
    await store.refresh([update]);
    expect(store.getSnapshot()).toEqual({ updates: [completed], openId: null });
    stop();
  });
});
