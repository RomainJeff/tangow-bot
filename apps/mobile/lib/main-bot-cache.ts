import { avatarIdentitySeed } from "@tangow/core";
import * as SecureStore from "expo-secure-store";

const MAIN_BOT_CACHE_KEY = "rakazo.main_bot";

export interface MainBotCacheEntry {
  color: string;
  shapeSeed: number;
}

/** The subset of a bot the main-bot selection and cache need. */
export interface MainBotCandidate {
  id: string;
  pinned: boolean;
  archivedAt: string | null;
  color: string;
  shapeSeed: number | null;
}

/**
 * The launch splash shows this bot's shape and color while it wakes up. Pure
 * so it can be unit-tested without SecureStore: the first pinned non-archived
 * bot in display order, falling back to the first non-archived bot, or `null`
 * when the user has none yet.
 */
export function selectMainBot(bots: readonly MainBotCandidate[]): MainBotCacheEntry | null {
  const live = bots.filter((bot) => !bot.archivedAt);
  const bot = live.find((candidate) => candidate.pinned) ?? live[0];
  if (!bot) return null;
  // Same fallback as `BotAvatar`: a bot with no picked shape derives one from its id.
  return { color: bot.color, shapeSeed: bot.shapeSeed ?? avatarIdentitySeed(bot.id) };
}

/**
 * Persists the main bot's look so the launch splash can read it before the
 * bot list has loaded from the server. Not sensitive, so a plain SecureStore
 * write is enough; wrapped in try/catch because a bootstrap-time failure here
 * must never block the app.
 */
export async function saveMainBotCache(bots: readonly MainBotCandidate[]): Promise<void> {
  const entry = selectMainBot(bots);
  try {
    if (entry) {
      await SecureStore.setItemAsync(MAIN_BOT_CACHE_KEY, JSON.stringify(entry));
    } else {
      await SecureStore.deleteItemAsync(MAIN_BOT_CACHE_KEY);
    }
  } catch {
    // Best effort: the splash falls back to the placeholder next launch.
  }
}

export async function loadMainBotCache(): Promise<MainBotCacheEntry | null> {
  try {
    const raw = await SecureStore.getItemAsync(MAIN_BOT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MainBotCacheEntry>;
    if (typeof parsed.color !== "string" || typeof parsed.shapeSeed !== "number") return null;
    return { color: parsed.color, shapeSeed: parsed.shapeSeed };
  } catch {
    return null;
  }
}

/** Clears the cached main bot, e.g. on sign-out, so the next launch shows the placeholder. */
export async function clearMainBotCache(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(MAIN_BOT_CACHE_KEY);
  } catch {
    // Best effort: a stale entry just shows the wrong bot until the next save.
  }
}
