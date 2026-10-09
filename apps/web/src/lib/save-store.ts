import { ORPCError } from "@orpc/client";
import { createSaveStore } from "@rakazo/core";

/**
 * The web app's one save store: fields save through it so a save outlives the
 * panel that started it. It lives in memory only, so a reload empties it, and
 * the app resets it whenever the signed-in person changes. A failed save shows
 * the server's own message; a network failure has none and reads "Could not save".
 */
export const saveStore = createSaveStore({
  reasonOf: (error) => (error instanceof ORPCError ? error.message : ""),
});
