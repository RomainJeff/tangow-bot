import type { ComputerStatus } from "@rakazo/contracts";

export const SCREEN_PROXY_TTL_MS = 60 * 60_000;
export const SCREEN_URL_RENEW_MS = SCREEN_PROXY_TTL_MS - 10 * 60_000;

/**
 * Every `computer/screenUrl` call seals a fresh capability, and the viewer is keyed by that URL.
 * Two statuses with the same key can share one URL, so clients re-read it only when the key
 * changes, when the held URL nears expiry, or when a read is forced.
 */
export function computerScreenKey(status: ComputerStatus): string {
  return [
    status.state,
    status.mode,
    status.kind,
    status.controlHolder,
    status.controlBotId,
    status.screenAvailable,
    status.screenWidth,
    status.screenHeight,
    status.screenStamp,
  ].join("|");
}

export interface HeldScreenUrl {
  url: string | null;
  /** The key of the status read before the request that produced `url`. */
  key: string;
  readAt: number;
}

export function isScreenUrlReusable(
  held: HeldScreenUrl | undefined,
  status: ComputerStatus | null | undefined,
  now: number,
  maxAgeMs: number = SCREEN_URL_RENEW_MS,
): boolean {
  if (!held || !status) return false;
  return held.key === computerScreenKey(status) && now - held.readAt < maxAgeMs;
}
