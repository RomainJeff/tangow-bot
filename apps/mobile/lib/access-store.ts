import * as SecureStore from "expo-secure-store";
import { type AccessCredentials, accessHeaders, defaultAccess, type StoredAccess } from "./access";

const ACCESS_KEY = "tangow.cf_access";

let cached: StoredAccess | null = null;

/**
 * The token to use for `origin`: the one the user stored for it, otherwise the
 * build-time token when `origin` is the build-time server. A token is never
 * reused across origins, so a user-entered server never receives either one.
 */
export function accessFor(origin: string, defaultOrigin: string): AccessCredentials | null {
  if (cached && cached.origin === origin) return cached;
  return origin === defaultOrigin ? defaultAccess() : null;
}

export function cachedAccess(): StoredAccess | null {
  return cached;
}

/** Reads the stored token into memory. Returns null when none matches `origin`. */
export async function loadAccess(origin: string): Promise<StoredAccess | null> {
  let raw: string | null = null;
  try {
    raw = await SecureStore.getItemAsync(ACCESS_KEY);
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  cached = raw ? readStored(raw) : null;
  if (cached && cached.origin !== origin) cached = null;
  return cached;
}

/** Persists the token for `origin`, or clears it when `credentials` is null. */
export async function saveAccess(
  origin: string,
  credentials: AccessCredentials | null,
): Promise<boolean> {
  const next: StoredAccess | null = credentials ? { ...credentials, origin } : null;
  try {
    if (next) await SecureStore.setItemAsync(ACCESS_KEY, JSON.stringify(next));
    else await SecureStore.deleteItemAsync(ACCESS_KEY);
  } catch {
    return false;
  }
  cached = next;
  return true;
}

/** Headers for `origin`. Empty unless a token applies to it. */
export function currentAccessHeaders(
  origin: string,
  defaultOrigin: string,
): Record<string, string> {
  return accessHeaders(accessFor(origin, defaultOrigin));
}

function readStored(raw: string): StoredAccess | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { origin, clientId, clientSecret } = parsed as Record<string, unknown>;
    if (typeof origin !== "string" || typeof clientId !== "string") return null;
    if (typeof clientSecret !== "string") return null;
    if (!origin || !clientId || !clientSecret) return null;
    return { origin, clientId, clientSecret };
  } catch {
    return null;
  }
}
