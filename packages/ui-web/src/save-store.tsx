import {
  type Draft,
  draftConflicts,
  type FieldSaveState,
  fieldValue,
  type SaveKey,
  type SaveStore,
} from "@tangow/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

const SaveStoreContext = createContext<SaveStore | null>(null);

/**
 * Hands one `SaveStore` to every field below it. The store lives outside React
 * (create it once at the composition root), so a save started in a panel
 * survives that panel closing and a draft survives it reopening.
 */
export function SaveStoreProvider({ store, children }: { store: SaveStore; children: ReactNode }) {
  return <SaveStoreContext.Provider value={store}>{children}</SaveStoreContext.Provider>;
}

export interface UseFieldSaveOptions<V> {
  key: SaveKey;
  /** What the server holds now. */
  serverValue: V;
  /** Writes `value`; rejects with the reason when it could not. */
  commit: (value: V) => Promise<void>;
}

export interface FieldSave<V> {
  state: FieldSaveState<V>;
  /**
   * What the server holds, or is about to: the value being saved while a save
   * is in flight, then the value saved while "Saved" shows, so a cache that
   * lags never shows the old value. A failed save falls back to the server
   * value, so a switch that could not be applied turns back by itself.
   */
  value: V;
  /** Unsaved text kept in memory. It conflicts when `value` moved since it began. */
  draft: Draft<V> | undefined;
  conflict: boolean;
  save: (value: V) => Promise<void>;
  retry: () => Promise<void>;
  /** Forgets a failed value once the field shows the server value again. */
  dismiss: () => void;
  /** Keeps the base of the draft already begun, else begins one on `value`; `null` drops it. */
  setDraft: (value: V | null) => void;
}

export function useFieldSave<V>({
  key,
  serverValue,
  commit,
}: UseFieldSaveOptions<V>): FieldSave<V> {
  const store = useContext(SaveStoreContext);
  if (!store) throw new Error("useFieldSave needs a SaveStoreProvider above it");
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(key, listener),
    [store, key],
  );
  const readState = () => store.state<V>(key);
  const readDraft = () => store.draft<V>(key);
  const state = useSyncExternalStore(subscribe, readState, readState);
  const draft = useSyncExternalStore(subscribe, readDraft, readDraft);
  const value = fieldValue(state, serverValue);
  return {
    state,
    value,
    draft,
    conflict: draftConflicts(draft, value),
    save: (next) => store.save(key, next, commit),
    retry: () => store.retry(key),
    dismiss: () => store.dismiss(key),
    setDraft: (next) => store.setDraft(key, next, fieldValue(store.state<V>(key), serverValue)),
  };
}
