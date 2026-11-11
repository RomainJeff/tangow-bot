import { fallbackORPCErrorMessage, ORPCError } from "@orpc/client";
import { createSaveStore } from "@tangow/core";

const EXPLAINED = new Set(["BAD_REQUEST", "CONFLICT", "FORBIDDEN", "NOT_FOUND"]);

/**
 * The API writes its own message for the refusals it explains. Anything else,
 * including oRPC's built-in English text for a code thrown bare, gives no
 * reason, so the field shows the translated "Could not save".
 */
export function saveFailureReason(error: unknown): string {
  if (!(error instanceof ORPCError) || !EXPLAINED.has(error.code)) return "";
  return error.message === fallbackORPCErrorMessage(error.code, undefined) ? "" : error.message;
}

/**
 * The web app's one save store: fields save through it so a save outlives the
 * panel that started it. It lives in memory only, so a reload empties it, and
 * the app resets it whenever the signed-in person changes.
 */
export const saveStore = createSaveStore({ reasonOf: saveFailureReason });
