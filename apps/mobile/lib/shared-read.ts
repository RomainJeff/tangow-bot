export type ReadState<T> = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; value: T };

/** A value read just now is reused rather than read again, as when a list opens from its row. */
const FRESH_MS = 30_000;

/**
 * One read shared by every screen that shows it, outside React: a screen that opens on data its
 * parent already read shows it at once. A failed read keeps a value already shown.
 */
export function createSharedRead<T>(now: () => number = Date.now) {
  let state: ReadState<T> = { kind: "loading" };
  let readAt = 0;
  let pending: Promise<void> | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (next: ReadState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    state: (): ReadState<T> => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Reads unless a read is under way or the value is fresh; `force` is a person's Retry. */
    refresh(load: () => Promise<T>, { force = false } = {}): Promise<void> {
      if (pending) return pending;
      if (!force && state.kind === "ready" && now() - readAt < FRESH_MS) return Promise.resolve();
      const mine = generation;
      if (state.kind === "failed") set({ kind: "loading" });
      const read = load().then(
        (value) => {
          if (mine !== generation) return;
          readAt = now();
          set({ kind: "ready", value });
        },
        () => {
          if (mine === generation && state.kind !== "ready") set({ kind: "failed" });
        },
      );
      pending = read.finally(() => {
        if (mine === generation) pending = null;
      });
      return pending;
    },
    /** Sign-out: the last person's value goes, and a read still under way is ignored. */
    reset(): void {
      generation += 1;
      pending = null;
      readAt = 0;
      set({ kind: "loading" });
    },
  };
}

export type SharedRead<T> = ReturnType<typeof createSharedRead<T>>;
