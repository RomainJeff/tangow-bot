import type { Me, VoiceInfo } from "@rakazo/contracts";
import { createSaveStore, type ModelCatalog } from "@rakazo/core";
import { createBotRecords } from "./bot-records";
import { serverMessage } from "./server-error";
import { createSharedRead } from "./shared-read";

/** One copy of the bot page's data and saves for the app session, outside React. */
export const botRecords = createBotRecords();

/** Field saves and unsaved drafts: memory only, so a draft never reaches the disk. */
export const botSaves = createSaveStore({ reasonOf: serverMessage });

/** What a bot's model and voice are picked from, shared by the rows and their lists. */
export const modelCatalogRead = createSharedRead<ModelCatalog>();
export const voicesRead = createSharedRead<VoiceInfo[]>();

/** The signed-in person, read once a session by the bot page. */
export const viewer: { current: Promise<Me> | null } = { current: null };

const runEnds = new Map<string, number>();
const runEndListeners = new Set<() => void>();

/** The thread tells the bot page a run ended: the bot may have changed its own settings. */
export function noteBotRunEnded(botId: string): void {
  runEnds.set(botId, (runEnds.get(botId) ?? 0) + 1);
  for (const listener of runEndListeners) listener();
}

export function botRunEpoch(botId: string): number {
  return runEnds.get(botId) ?? 0;
}

export function subscribeBotRunEnds(listener: () => void): () => void {
  runEndListeners.add(listener);
  return () => {
    runEndListeners.delete(listener);
  };
}

/** Sign-out: nothing of the last person's bots, saves or drafts stays in memory. */
export function resetBotPage(): void {
  botRecords.reset();
  botSaves.reset();
  runEnds.clear();
  viewer.current = null;
  modelCatalogRead.reset();
  voicesRead.reset();
}
