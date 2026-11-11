import type { ComputerStatus } from "@tangow/contracts";
import type { HeldScreenUrl } from "@tangow/core";
import { computerScreenKey, isScreenUrlReusable, SCREEN_PROXY_TTL_MS } from "@tangow/core";

export interface ComputerScreenResult {
  url: string | null;
  error: string | null;
}

/**
 * Each read returns a new URL, and a new URL reloads the viewer. A background read keeps the held
 * URL while it is reusable for the current status and joins a read already in flight for the same
 * status; a forced read always asks again. A read that fails keeps the held URL while the proxy
 * still accepts it. Only the latest request for the visible computer may replace its screen or
 * error.
 */
export async function loadComputerScreen(options: {
  botId: string;
  status: ComputerStatus | null;
  held: HeldScreenUrl | undefined;
  force?: boolean;
  reads: Map<string, Promise<HeldScreenUrl>>;
  load: () => Promise<{ url: string | null }>;
  isCurrent: () => boolean;
  commit: (result: ComputerScreenResult, held: HeldScreenUrl | undefined) => void;
  fallbackError: string;
}): Promise<string | null> {
  const { held, status, force = false } = options;
  const key = status ? computerScreenKey(status) : "";
  const slot = `${options.botId}:${key}`;
  const inflight = force ? undefined : options.reads.get(slot);
  if (!force && !inflight && held && isScreenUrlReusable(held, status, Date.now())) {
    if (!options.isCurrent()) return null;
    options.commit({ url: held.url, error: null }, held);
    return held.url;
  }
  let result: ComputerScreenResult;
  let next: HeldScreenUrl | undefined;
  try {
    next = await (inflight ?? startRead(options.reads, slot, key, options.load));
    result = { url: next.url, error: null };
  } catch (error) {
    if (held && isScreenUrlReusable(held, status, Date.now(), SCREEN_PROXY_TTL_MS)) {
      return options.isCurrent() ? held.url : null;
    }
    result = {
      url: null,
      error: error instanceof Error && error.message ? error.message : options.fallbackError,
    };
  }
  if (!options.isCurrent()) return null;
  options.commit(result, next);
  return result.url;
}

function startRead(
  reads: Map<string, Promise<HeldScreenUrl>>,
  slot: string,
  key: string,
  load: () => Promise<{ url: string | null }>,
): Promise<HeldScreenUrl> {
  const readAt = Date.now();
  const read = load()
    .then(({ url }) => ({ url, key, readAt }))
    .finally(() => {
      if (reads.get(slot) === read) reads.delete(slot);
    });
  reads.set(slot, read);
  return read;
}

/** The URL to paint when returning to a bot: its held one, only while it still fits the cached status. */
export function cachedScreenUrl(
  held: HeldScreenUrl | undefined,
  status: ComputerStatus | null | undefined,
  now: number,
): string | null {
  return isScreenUrlReusable(held, status, now) ? (held?.url ?? null) : null;
}
