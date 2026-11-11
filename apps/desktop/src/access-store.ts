import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DesktopAccessCredentials } from "@tangow/contracts";
import { safeStorage } from "electron";
import { ACCESS_FILE_NAME } from "./setup-config.js";
import { writePrivateFile } from "./setup-store.js";

/** A service token is only ever sent to the origin it was entered for. */
export interface StoredAccess extends DesktopAccessCredentials {
  origin: string;
}

export function accessFilePath(userDataDir: string): string {
  return path.join(userDataDir, ACCESS_FILE_NAME);
}

/** False on systems without a keychain (Keychain, DPAPI, libsecret). */
export function accessStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Returns null when no token is stored, or when the stored blob is unusable. */
export async function readAccess(userDataDir: string): Promise<StoredAccess | null> {
  let encoded: string;
  try {
    encoded = await readFile(accessFilePath(userDataDir), "utf8");
  } catch {
    return null;
  }
  if (!accessStorageAvailable()) return null;
  try {
    const parsed: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, "base64")));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { origin, clientId, clientSecret } = parsed as Record<string, unknown>;
    if (typeof origin !== "string" || typeof clientId !== "string") return null;
    if (typeof clientSecret !== "string") return null;
    if (origin === "" || clientId === "" || clientSecret === "") return null;
    return { clientId, clientSecret, origin };
  } catch {
    // A blob from another machine or a rotated OS key is unreadable; ask again.
    return null;
  }
}

/** Writes the token encrypted, or clears it when `record` is null. */
export async function persistAccess(
  userDataDir: string,
  record: StoredAccess | null,
): Promise<void> {
  if (record === null) {
    await rm(accessFilePath(userDataDir), { force: true });
    return;
  }
  if (!accessStorageAvailable()) {
    throw new Error("Secure credential storage is unavailable on this system.");
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(record));
  await mkdir(userDataDir, { recursive: true });
  await writePrivateFile(accessFilePath(userDataDir), encrypted.toString("base64"));
}
