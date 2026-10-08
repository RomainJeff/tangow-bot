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
  /** The "Saved" meta shows from `at` until `until`, both epoch ms. */
  | { kind: "saved"; at: number; until: number }
  | { kind: "failed"; value: V; reason: string; attempt: number };

/** `base` is the server value when the draft began. */
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
        ? { kind: "saved", at: event.now, until: event.now + event.savedFor }
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

/** A draft conflicts when the server value moved since the draft began. */
export function draftConflicts<V>(draft: Draft<V> | undefined, serverValue: V): boolean {
  return draft !== undefined && draft.base !== serverValue;
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
   * Runs `commit` and tracks it. The last submit for a key wins: the result of
   * an earlier in-flight commit is dropped. Never rejects; a failure is the
   * `failed` state. Resolves once this commit has settled.
   */
  save<V>(key: SaveKey, value: V, commit: (value: V) => Promise<void>): Promise<void>;
  /** Submits the failed value again through the commit that failed. */
  retry(key: SaveKey): Promise<void>;
  /** Forgets a failed value, so Retry has nothing left to send. */
  dismiss(key: SaveKey): void;
  /** A stable reference until the state changes. A key holds one value type. */
  state<V>(key: SaveKey): FieldSaveState<V>;
  setDraft<V>(key: SaveKey, draft: Draft<V> | null): void;
  draft<V>(key: SaveKey): Draft<V> | undefined;
  subscribe(key: SaveKey, listener: () => void): () => void;
  /** Drops every state and draft, and ignores commits still in flight: called on sign-out. */
  reset(): void;
}

export interface SaveStoreOptions {
  now?: () => number;
  /** How long "Saved" shows, in ms. */
  savedFor?: number;
  /** The reason a failed commit shows; `""` when there is nothing worth showing. */
  reasonOf?: (error: unknown) => string;
}

export function createSaveStore({
  now = Date.now,
  savedFor = 3000,
  reasonOf = (error) => (error instanceof Error ? error.message : ""),
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

  const store: SaveStore = {
    async save<V>(key: SaveKey, value: V, commit: (value: V) => Promise<void>) {
      const started = generation;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      commits.set(key, commit as (value: never) => Promise<void>);
      dispatch(key, { type: "submit", value, attempt });
      try {
        await commit(value);
      } catch (error) {
        if (started !== generation) return;
        dispatch(key, {
          type: "failed",
          attempt,
          reason: reasonOf(error),
        });
        return;
      }
      if (started !== generation) return;
      dispatch(key, { type: "succeeded", attempt, now: now(), savedFor });
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
    setDraft<V>(key: SaveKey, draft: Draft<V> | null) {
      if (draft) drafts.set(key, draft);
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
      for (const map of [states, drafts, attempts, commits, timers]) map.clear();
      for (const key of touched) notify(key);
    },
  };
  return store;
}
