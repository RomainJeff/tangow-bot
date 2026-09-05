import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

/** Persisted global "Display agent steps" preference. Default off. */
export const AGENT_STEPS_KEY = "rakazo.display-agent-steps";

let enabled = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getDisplayAgentSteps(): boolean {
  return enabled;
}

/** Hydrates the in-memory value at boot; SecureStore reads are async. */
export async function loadDisplayAgentSteps(): Promise<boolean> {
  try {
    enabled = (await SecureStore.getItemAsync(AGENT_STEPS_KEY)) === "1";
  } catch {
    // SecureStore unavailable in some test / web hosts — keep the default.
  }
  notify();
  return enabled;
}

export async function setDisplayAgentSteps(on: boolean): Promise<void> {
  if (on === enabled) return;
  enabled = on;
  notify();
  try {
    if (on) await SecureStore.setItemAsync(AGENT_STEPS_KEY, "1");
    else await SecureStore.deleteItemAsync(AGENT_STEPS_KEY);
  } catch {
    // Keep the in-memory value when storage is blocked.
  }
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
