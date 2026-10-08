import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSaveStore,
  decideTextCommit,
  draftConflicts,
  type FieldSaveState,
  reduceFieldSave,
  type SaveEvent,
  saveKey,
} from "./field-save.js";

const idle: FieldSaveState<string> = { kind: "idle" };

describe("reduceFieldSave", () => {
  const cases: Array<[string, FieldSaveState<string>, SaveEvent<string>, FieldSaveState<string>]> =
    [
      [
        "submit from idle",
        idle,
        { type: "submit", value: "a", attempt: 1 },
        { kind: "saving", value: "a", attempt: 1 },
      ],
      [
        "submit while saving replaces the value",
        { kind: "saving", value: "a", attempt: 1 },
        { type: "submit", value: "b", attempt: 2 },
        { kind: "saving", value: "b", attempt: 2 },
      ],
      [
        "submit after a failure",
        { kind: "failed", value: "a", reason: "no", attempt: 1 },
        { type: "submit", value: "b", attempt: 2 },
        { kind: "saving", value: "b", attempt: 2 },
      ],
      [
        "submit for an attempt already seen is ignored",
        { kind: "saving", value: "b", attempt: 2 },
        { type: "submit", value: "a", attempt: 1 },
        { kind: "saving", value: "b", attempt: 2 },
      ],
      [
        "success of the current attempt",
        { kind: "saving", value: "a", attempt: 1 },
        { type: "succeeded", attempt: 1, now: 1000, savedFor: 3000 },
        { kind: "saved", at: 1000, until: 4000 },
      ],
      [
        "stale success for an older attempt",
        { kind: "saving", value: "b", attempt: 2 },
        { type: "succeeded", attempt: 1, now: 1000, savedFor: 3000 },
        { kind: "saving", value: "b", attempt: 2 },
      ],
      [
        "duplicate success after saved",
        { kind: "saved", at: 1000, until: 4000 },
        { type: "succeeded", attempt: 1, now: 2000, savedFor: 3000 },
        { kind: "saved", at: 1000, until: 4000 },
      ],
      [
        "failure of the current attempt keeps the value",
        { kind: "saving", value: "a", attempt: 1 },
        { type: "failed", attempt: 1, reason: "offline" },
        { kind: "failed", value: "a", reason: "offline", attempt: 1 },
      ],
      [
        "stale failure for an older attempt",
        { kind: "saving", value: "b", attempt: 2 },
        { type: "failed", attempt: 1, reason: "offline" },
        { kind: "saving", value: "b", attempt: 2 },
      ],
      [
        "expiry before until",
        { kind: "saved", at: 1000, until: 4000 },
        { type: "expire", now: 3999 },
        { kind: "saved", at: 1000, until: 4000 },
      ],
      [
        "expiry at until",
        { kind: "saved", at: 1000, until: 4000 },
        { type: "expire", now: 4000 },
        idle,
      ],
      [
        "dismiss forgets a failed value",
        { kind: "failed", value: "a", reason: "no", attempt: 1 },
        { type: "dismiss" },
        idle,
      ],
      [
        "dismiss never cancels a save in flight",
        { kind: "saving", value: "a", attempt: 1 },
        { type: "dismiss" },
        { kind: "saving", value: "a", attempt: 1 },
      ],
      [
        "expiry never clears a save in flight",
        { kind: "saving", value: "a", attempt: 3 },
        { type: "expire", now: 99999 },
        { kind: "saving", value: "a", attempt: 3 },
      ],
    ];

  it.each(cases)("%s", (_, state, event, expected) => {
    expect(reduceFieldSave(state, event)).toEqual(expected);
  });

  it("returns the same reference when nothing changes", () => {
    const state: FieldSaveState<string> = { kind: "saving", value: "b", attempt: 2 };
    expect(reduceFieldSave(state, { type: "succeeded", attempt: 1, now: 0, savedFor: 1 })).toBe(
      state,
    );
  });
});

describe("decideTextCommit", () => {
  const cases: Array<[string, string, string, Parameters<typeof decideTextCommit>[2], string]> = [
    ["unchanged", "Ada", "Ada", {}, "skip"],
    ["unchanged once trimmed", "Ada", "  Ada \n", {}, "skip"],
    ["a stored value with stray spaces, retyped clean", " Ada ", "Ada", {}, "skip"],
    ["both empty", "", "   ", { required: true }, "skip"],
    ["changed", "Ada", "Ada L", {}, "commit"],
    ["emptied required field", "Ada", "  ", { required: true }, "revert"],
    ["emptied field that asks first", "Be kind.", "", { confirmClear: true }, "confirm"],
    ["emptied field with no confirmation", "Be kind.", "", {}, "commit"],
    ["filled from empty", "", "Be kind.", { confirmClear: true }, "commit"],
    [
      "required wins over confirmation",
      "Ada",
      "",
      { required: true, confirmClear: true },
      "revert",
    ],
  ];
  it.each(cases)("%s", (_, previous, next, options, expected) => {
    expect(decideTextCommit(previous, next, options)).toBe(expected);
  });
});

describe("draftConflicts", () => {
  it("is derived from the base the draft began on", () => {
    const draft = { value: "typed", base: "v1" };
    expect(draftConflicts(draft, "v1")).toBe(false);
    expect(draftConflicts(draft, "v2")).toBe(true);
    expect(draftConflicts(undefined, "v2")).toBe(false);
  });
});

describe("saveKey", () => {
  it("separates people, spaces, bots and fields", () => {
    const scope = { userId: "u1", spaceId: "s1" };
    const keys = new Set([
      saveKey(scope, "b1", "name"),
      saveKey({ ...scope, userId: "u2" }, "b1", "name"),
      saveKey({ ...scope, spaceId: "s2" }, "b1", "name"),
      saveKey(scope, "b2", "name"),
      saveKey(scope, "b1", "title"),
      saveKey({ userId: "u1/s1", spaceId: "" }, "b1", "name"),
    ]);
    expect(keys.size).toBe(6);
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSaveStore", () => {
  const key = saveKey({ userId: "u", spaceId: "s" }, "b", "instructions");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes idle, saving, saved, then idle again after savedFor", async () => {
    const store = createSaveStore();
    const commit = deferred();
    expect(store.state(key)).toEqual({ kind: "idle" });

    const done = store.save(key, "hello", () => commit.promise);
    expect(store.state(key)).toEqual({ kind: "saving", value: "hello", attempt: 1 });

    commit.resolve();
    await done;
    expect(store.state(key)).toEqual({ kind: "saved", at: 1_000_000, until: 1_003_000 });

    vi.advanceTimersByTime(2999);
    expect(store.state(key).kind).toBe("saved");
    vi.advanceTimersByTime(1);
    expect(store.state(key)).toEqual({ kind: "idle" });
  });

  it("honours a custom savedFor and clock", async () => {
    let clock = 50;
    const store = createSaveStore({ now: () => clock, savedFor: 10 });
    await store.save(key, "x", async () => {});
    expect(store.state(key)).toEqual({ kind: "saved", at: 50, until: 60 });
    clock = 60;
    vi.advanceTimersByTime(10);
    expect(store.state(key).kind).toBe("idle");
  });

  it("calls the commit with the value and lets the last submit win", async () => {
    const store = createSaveStore();
    const first = deferred();
    const second = deferred();
    const commit = vi.fn<(value: string) => Promise<void>>();
    commit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const a = store.save(key, "one", commit);
    const b = store.save(key, "two", commit);
    expect(commit.mock.calls).toEqual([["one"], ["two"]]);
    expect(store.state(key)).toEqual({ kind: "saving", value: "two", attempt: 2 });

    first.resolve();
    await a;
    expect(store.state(key)).toEqual({ kind: "saving", value: "two", attempt: 2 });

    second.resolve();
    await b;
    expect(store.state(key).kind).toBe("saved");
  });

  it("drops the failure of an earlier commit once a later one is under way", async () => {
    const store = createSaveStore();
    const first = deferred();
    const second = deferred();
    const a = store.save(key, "one", () => first.promise);
    const b = store.save(key, "two", () => second.promise);

    first.reject(new Error("offline"));
    await a;
    expect(store.state(key)).toEqual({ kind: "saving", value: "two", attempt: 2 });
    second.resolve();
    await b;
    expect(store.state(key).kind).toBe("saved");
  });

  it("keeps the value on failure and retries it through the same commit", async () => {
    const store = createSaveStore();
    const commit = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Computer is controlled"))
      .mockResolvedValueOnce();

    await store.save(key, "Team", commit);
    expect(store.state(key)).toEqual({
      kind: "failed",
      value: "Team",
      reason: "Computer is controlled",
      attempt: 1,
    });

    await store.retry(key);
    expect(commit.mock.calls).toEqual([["Team"], ["Team"]]);
    expect(store.state(key).kind).toBe("saved");
  });

  it("gives an empty reason when the failure carries none", async () => {
    const store = createSaveStore();
    await store.save(key, "x", () => Promise.reject("boom"));
    expect(store.state(key)).toMatchObject({ kind: "failed", reason: "" });
  });

  it("takes the reason from reasonOf, so a caller can keep only what the server said", async () => {
    const store = createSaveStore({
      reasonOf: (error) => (error instanceof RangeError ? error.message : ""),
    });
    await store.save(key, "a", () => Promise.reject(new RangeError("Add a run time.")));
    expect(store.state(key)).toMatchObject({ kind: "failed", reason: "Add a run time." });
    await store.save(key, "b", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(store.state(key)).toMatchObject({ kind: "failed", reason: "" });
  });

  it("retry does nothing unless the field failed", async () => {
    const store = createSaveStore();
    const commit = vi.fn(async () => {});
    await store.retry(key);
    await store.save(key, "x", commit);
    await store.retry(key);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("restarts the Saved window on a second save", async () => {
    const store = createSaveStore();
    await store.save(key, "a", async () => {});
    vi.advanceTimersByTime(2000);
    await store.save(key, "b", async () => {});
    vi.advanceTimersByTime(2000);
    expect(store.state(key).kind).toBe("saved");
    vi.advanceTimersByTime(1000);
    expect(store.state(key).kind).toBe("idle");
  });

  it("keeps fields apart", async () => {
    const store = createSaveStore();
    const other = saveKey({ userId: "u", spaceId: "s" }, "b", "title");
    await store.save(key, "a", async () => {});
    expect(store.state(other)).toEqual({ kind: "idle" });
  });

  it("notifies subscribers of that key only, and stops after unsubscribe", async () => {
    const store = createSaveStore();
    const other = saveKey({ userId: "u", spaceId: "s" }, "b", "title");
    const mine = vi.fn();
    const theirs = vi.fn();
    const stop = store.subscribe(key, mine);
    store.subscribe(other, theirs);

    await store.save(key, "a", async () => {});
    expect(mine).toHaveBeenCalledTimes(2);
    expect(theirs).not.toHaveBeenCalled();

    stop();
    vi.advanceTimersByTime(3000);
    expect(mine).toHaveBeenCalledTimes(2);
  });

  it("returns the same state object until something changes", async () => {
    const store = createSaveStore();
    const untouched = saveKey({ userId: "u", spaceId: "s" }, "b", "x");
    await store.save(key, "a", async () => {});
    expect(store.state(key)).toBe(store.state(key));
    expect(store.state(untouched)).toBe(store.state(untouched));
  });

  it("keeps drafts in memory with their base, and clears them with null", () => {
    const store = createSaveStore();
    const listener = vi.fn();
    store.subscribe(key, listener);
    expect(store.draft(key)).toBeUndefined();

    store.setDraft(key, { value: "typed", base: "server" });
    expect(store.draft(key)).toEqual({ value: "typed", base: "server" });
    expect(listener).toHaveBeenCalledTimes(1);

    store.setDraft(key, null);
    expect(store.draft(key)).toBeUndefined();
    store.setDraft(key, null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reset drops states and drafts, cancels expiry and ignores commits still in flight", async () => {
    const store = createSaveStore();
    const listener = vi.fn();
    store.subscribe(key, listener);
    const pendingKey = saveKey({ userId: "u", spaceId: "s" }, "b", "pending");
    const inFlight = deferred();

    await store.save(key, "a", async () => {});
    store.setDraft(key, { value: "typed", base: "a" });
    const pending = store.save(pendingKey, "p", () => inFlight.promise);
    listener.mockClear();

    store.reset();
    expect(store.state(key)).toEqual({ kind: "idle" });
    expect(store.draft(key)).toBeUndefined();
    expect(store.state(pendingKey)).toEqual({ kind: "idle" });
    expect(listener).toHaveBeenCalled();

    inFlight.resolve();
    await pending;
    expect(store.state(pendingKey)).toEqual({ kind: "idle" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is usable again after a reset", async () => {
    const store = createSaveStore();
    await store.save(key, "a", async () => {});
    store.reset();
    await store.save(key, "b", async () => {});
    expect(store.state(key).kind).toBe("saved");
  });
});

describe("field-save.ts", () => {
  it("has no way to reach browser storage", () => {
    const source = readFileSync(new URL("./field-save.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});
