import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

/**
 * Debug mode, kept on this device only: agent steps and every run in Activity. Default off. The
 * key is the one "Display agent steps" used, which debug mode took over.
 */
export const DEBUG_MODE_KEY = "rakazo.display-agent-steps";

let enabled = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getDebugMode(): boolean {
  return enabled;
}

/** Hydrates the in-memory value at boot; SecureStore reads are async. */
export async function loadDebugMode(): Promise<boolean> {
  try {
    enabled = (await SecureStore.getItemAsync(DEBUG_MODE_KEY)) === "1";
  } catch {
    // SecureStore unavailable in some test / web hosts — keep the default.
  }
  notify();
  return enabled;
}

export async function setDebugMode(on: boolean): Promise<void> {
  if (on === enabled) return;
  enabled = on;
  notify();
  try {
    if (on) await SecureStore.setItemAsync(DEBUG_MODE_KEY, "1");
    else await SecureStore.deleteItemAsync(DEBUG_MODE_KEY);
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

export function useDebugMode(): boolean {
  return useSyncExternalStore(subscribe, getDebugMode, () => false);
}
