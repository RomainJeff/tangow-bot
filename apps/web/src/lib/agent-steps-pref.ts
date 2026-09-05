import { useSyncExternalStore } from "react";

/** Persisted global "Display agent steps" preference. Default off. */
export const AGENT_STEPS_KEY = "rakazo.display-agent-steps";

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(AGENT_STEPS_KEY) === "1";
  } catch {
    return false;
  }
}

let enabled = typeof window === "undefined" ? false : read();

export function getDisplayAgentSteps(): boolean {
  return enabled;
}

export function setDisplayAgentSteps(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  try {
    if (on) window.localStorage.setItem(AGENT_STEPS_KEY, "1");
    else window.localStorage.removeItem(AGENT_STEPS_KEY);
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

export function useDisplayAgentSteps(): boolean {
  return useSyncExternalStore(subscribe, getDisplayAgentSteps, () => false);
}
