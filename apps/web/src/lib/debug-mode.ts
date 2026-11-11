import { useSyncExternalStore } from "react";

/**
 * Debug mode, kept on this device only: agent steps and every run in Activity. Default off. The
 * key is the one "Display agent steps" used, which debug mode took over.
 */
export const DEBUG_MODE_KEY = "tangow.display-agent-steps";

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(DEBUG_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = typeof window === "undefined" ? false : read();

export function getDebugMode(): boolean {
  return enabled;
}

export function setDebugMode(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  try {
    if (on) window.localStorage.setItem(DEBUG_MODE_KEY, "1");
    else window.localStorage.removeItem(DEBUG_MODE_KEY);
  } catch {
    // Private mode / blocked storage — keep the in-memory value only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDebugMode(): boolean {
  return useSyncExternalStore(subscribe, getDebugMode, () => false);
}
