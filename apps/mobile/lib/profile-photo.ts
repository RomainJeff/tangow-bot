import { useSyncExternalStore } from "react";

export const PROFILE_PHOTO_SIZE = 128;
// Mirrors the server guard in @rakazo/auth: the photo rides in every session payload.
export const PROFILE_PHOTO_MAX_LENGTH = 32 * 1024;

export type ProfilePhotoEncoding =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: "unreadable" | "too-large" };

/** Wraps the encoder's base64 in the data URL the server guard accepts. */
export function profilePhotoDataUrl(base64: string | null | undefined): ProfilePhotoEncoding {
  if (!base64) return { ok: false, reason: "unreadable" };
  const dataUrl = `data:image/webp;base64,${base64}`;
  if (dataUrl.length > PROFILE_PHOTO_MAX_LENGTH) return { ok: false, reason: "too-large" };
  return { ok: true, dataUrl };
}

let photo: string | null = null;
const listeners = new Set<() => void>();

export function getProfilePhoto(): string | null {
  return photo;
}

/** Shared so a save on the account screen shows up on the inbox without a reload. */
export function setProfilePhoto(next: string | null): void {
  if (next === photo) return;
  photo = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useProfilePhoto(): string | null {
  return useSyncExternalStore(subscribe, getProfilePhoto, () => null);
}
