import { useSyncExternalStore } from "react";

/**
 * The dictation input level, outside React state: the engine reports it ten
 * times a second, and as state of the thread screen each report re-rendered
 * every visible message. Only the waveform subscribes to it.
 */
export interface VolumeStore {
  get: () => number | null;
  set: (value: number | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createVolumeStore(): VolumeStore {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The level, for the one component that draws it. */
export function useVolume(store: VolumeStore | undefined): number | null {
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.get ?? nullValue,
    store?.get ?? nullValue,
  );
}

const noopSubscribe = () => () => undefined;
const nullValue = () => null;
