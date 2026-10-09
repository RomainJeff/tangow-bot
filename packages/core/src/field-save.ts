/**
 * One field's autosave, as a state machine and a store that outlives the
 * component showing it. No I/O: the only outside world is the clock and the
 * `commit` a caller hands in, so a draft can never reach a disk from here and
 * the same machine runs on web, desktop and mobile.
 */

export type SaveKey = string & { readonly __brand: "SaveKey" };

/** The person, space and bot a field belongs to: a draft or a save never outlives any of them. */
export function saveKey(
  scope: { userId: string; spaceId: string },
  botId: string,
  field: string,
): SaveKey {
  return JSON.stringify([scope.userId, scope.spaceId, botId, field]) as SaveKey;
}

export type FieldSaveState<V> =
  | { kind: "idle" }
  | { kind: "saving"; value: V; attempt: number }
  /**
   * The "Saved" meta shows from `at` until `until`, both epoch ms. `value` is
   * what was saved: the field shows it over a server value the caller has yet
   * to refresh.
   */
  | { kind: "saved"; value: V; at: number; until: number }
  | { kind: "failed"; value: V; reason: string; attempt: number };

/** `base` is the field's value when the draft began, a save of the person's own in flight included. */
export type Draft<V> = { value: V; base: V };

export type SaveEvent<V> =
  | { type: "submit"; value: V; attempt: number }
  | { type: "succeeded"; attempt: number; now: number; savedFor: number }
  | { type: "failed"; attempt: number; reason: string }
  | { type: "expire"; now: number }
  /** The text went back to the server value, so the failed value is no longer wanted. */
  | { type: "dismiss" };

const IDLE = { kind: "idle" } as const;

function attemptOf(state: FieldSaveState<unknown>): number {
  return state.kind === "saving" || state.kind === "failed" ? state.attempt : 0;
}

/**
 * Idempotent: an event about an attempt that is no longer the current one
 * (a late result for a value since replaced, a duplicate delivery) returns the
 * state untouched.
 */
export function reduceFieldSave<V>(
  state: FieldSaveState<V>,
  event: SaveEvent<V>,
): FieldSaveState<V> {
  switch (event.type) {
    case "submit":
      return event.attempt > attemptOf(state)
        ? { kind: "saving", value: event.value, attempt: event.attempt }
        : state;
    case "succeeded":
      return state.kind === "saving" && state.attempt === event.attempt
        ? { kind: "saved", value: state.value, at: event.now, until: event.now + event.savedFor }
        : state;
    case "failed":
      return state.kind === "saving" && state.attempt === event.attempt
        ? { kind: "failed", value: state.value, reason: event.reason, attempt: state.attempt }
        : state;
    case "expire":
      return state.kind === "saved" && event.now >= state.until ? IDLE : state;
    case "dismiss":
      return state.kind === "failed" ? IDLE : state;
  }
}

/**
 * What a field holds: the value being saved, or the value just saved for as
 * long as "Saved" shows, so a caller whose cache lags behind the commit never
 * shows the old value next to "Saved"; else the server value.
 */
export function fieldValue<V>(state: FieldSaveState<V>, serverValue: V): V {
  return state.kind === "saving" || state.kind === "saved" ? state.value : serverValue;
}

/**
 * A draft conflicts when the field's value moved since the draft began.
 * `value` is what the field holds now, a save in flight included, so the
 * person's own save never reads as a change made elsewhere.
 */
export function draftConflicts<V>(draft: Draft<V> | undefined, value: V): boolean {
  return draft !== undefined && draft.base !== value;
}

export type TextCommit = "skip" | "revert" | "confirm" | "commit";

/**
 * What a text field does when it loses focus. `skip`: nothing changed once
 * trimmed. `revert`: a required field (a name) was emptied, put the old value
 * back. `confirm`: a non-empty field that asks first was emptied. `commit`:
 * save the trimmed value.
 */
export function decideTextCommit(
  previous: string,
  next: string,
  options: { required?: boolean; confirmClear?: boolean } = {},
): TextCommit {
  const value = next.trim();
  const before = previous.trim();
  if (value === before) return "skip";
  if (value === "") {
    if (options.required) return "revert";
    if (options.confirmClear) return "confirm";
  }
  return "commit";
}

export interface SaveStore {
  /**
   * Saves `value` through `commit` and tracks it. A key has at most one commit
   * in flight, so the server ends on the newest value whatever order the
   * network answers in: a value submitted meanwhile waits, replaces any value
   * still waiting, and is sent once the commit in flight settles unless that
   * commit already wrote it. Never rejects; a failure is the `failed` state.
   * Resolves once nothing is left to send for the key.
   */
  save<V>(key: SaveKey, value: V, commit: (value: V) => Promise<void>): Promise<void>;
  /** Submits the failed value again through the commit that failed. */
  retry(key: SaveKey): Promise<void>;
  /** Forgets a failed value, so Retry has nothing left to send. */
  dismiss(key: SaveKey): void;
  /** A stable reference until the state changes. A key holds one value type. */
  state<V>(key: SaveKey): FieldSaveState<V>;
  /**
   * Keeps `value` as the key's draft, on the base of the draft already begun or
   * else on `current`, the field's value now; `null` drops it.
   */
  setDraft<V>(key: SaveKey, value: V | null, current: V): void;
  draft<V>(key: SaveKey): Draft<V> | undefined;
  subscribe(key: SaveKey, listener: () => void): () => void;
  /** Drops every state and draft, and ignores commits still in flight: called on sign-out. */
  reset(): void;
}

export interface SaveStoreOptions {
  now?: () => number;
  /** How long "Saved" shows, in ms. */
  savedFor?: number;
  /**
   * The reason a failed commit shows; `""` when there is nothing worth showing,
   * which is the default: a raw error message ("Failed to fetch") never reaches
   * the person unless the caller knows it was written for them.
   */
  reasonOf?: (error: unknown) => string;
}

export function createSaveStore({
  now = Date.now,
  savedFor = 3000,
  reasonOf = () => "",
}: SaveStoreOptions = {}): SaveStore {
  const states = new Map<SaveKey, FieldSaveState<unknown>>();
  const drafts = new Map<SaveKey, Draft<unknown>>();
  const attempts = new Map<SaveKey, number>();
  const commits = new Map<SaveKey, (value: never) => Promise<void>>();
  const timers = new Map<SaveKey, ReturnType<typeof setTimeout>>();
  const listeners = new Map<SaveKey, Set<() => void>>();
  let generation = 0;

  const notify = (key: SaveKey) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };

  const schedule = (key: SaveKey) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    const state = states.get(key);
    if (state?.kind !== "saved") return;
    timers.set(
      key,
      setTimeout(
        () => {
          timers.delete(key);
          dispatch(key, { type: "expire", now: now() });
        },
        Math.max(0, state.until - now()),
      ),
    );
  };

  const dispatch = (key: SaveKey, event: SaveEvent<unknown>) => {
    const before = states.get(key) ?? IDLE;
    const after = reduceFieldSave(before, event);
    if (after === before) {
      if (event.type === "expire") schedule(key);
      return;
    }
    if (after.kind === "idle") states.delete(key);
    else states.set(key, after);
    schedule(key);
    notify(key);
  };

  type Queued = { value: unknown; commit: (value: never) => Promise<void>; attempt: number };
  const queued = new Map<SaveKey, Queued>();
  const running = new Map<SaveKey, Promise<void>>();

  const drain = async (key: SaveKey) => {
    const started = generation;
    let written: { value: unknown } | undefined;
    for (let next = queued.get(key); next; next = queued.get(key)) {
      queued.delete(key);
      const { value, attempt } = next;
      if (written && Object.is(written.value, value)) {
        dispatch(key, { type: "succeeded", attempt, now: now(), savedFor });
        continue;
      }
      try {
        await (next.commit as (value: unknown) => Promise<void>)(value);
      } catch (error) {
        if (started !== generation) return;
        written = undefined;
        dispatch(key, { type: "failed", attempt, reason: reasonOf(error) });
        continue;
      }
      if (started !== generation) return;
      written = { value };
      dispatch(key, { type: "succeeded", attempt, now: now(), savedFor });
    }
    // In the same tick as the empty queue was seen, so a save arriving next starts a new run.
    running.delete(key);
  };

  const store: SaveStore = {
    save<V>(key: SaveKey, value: V, commit: (value: V) => Promise<void>) {
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      commits.set(key, commit as (value: never) => Promise<void>);
      queued.set(key, { value, commit: commit as (value: never) => Promise<void>, attempt });
      dispatch(key, { type: "submit", value, attempt });
      const run = running.get(key) ?? drain(key);
      running.set(key, run);
      return run;
    },
    async retry(key) {
      const state = states.get(key);
      const commit = commits.get(key);
      if (state?.kind !== "failed" || !commit) return;
      await store.save(key, state.value, commit as (value: unknown) => Promise<void>);
    },
    dismiss(key) {
      dispatch(key, { type: "dismiss" });
    },
    state<V>(key: SaveKey) {
      return (states.get(key) ?? IDLE) as FieldSaveState<V>;
    },
    setDraft<V>(key: SaveKey, value: V | null, current: V) {
      if (value !== null) drafts.set(key, { value, base: drafts.get(key)?.base ?? current });
      else if (!drafts.delete(key)) return;
      notify(key);
    },
    draft<V>(key: SaveKey) {
      return drafts.get(key) as Draft<V> | undefined;
    },
    subscribe(key, listener) {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
    reset() {
      generation += 1;
      for (const timer of timers.values()) clearTimeout(timer);
      const touched = new Set([...states.keys(), ...drafts.keys()]);
      for (const map of [states, drafts, attempts, commits, timers, queued, running]) map.clear();
      for (const key of touched) notify(key);
    },
  };
  return store;
}
