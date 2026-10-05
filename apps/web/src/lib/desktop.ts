import type { RakazoDesktop, RakazoDesktopOAuthCallback } from "@rakazo/contracts";

export type { RakazoDesktop, RakazoDesktopOAuthCallback } from "@rakazo/contracts";

declare global {
  interface Window {
    rakazoDesktop?: RakazoDesktop;
  }
}

export function desktopBridge(): RakazoDesktop | undefined {
  return typeof window === "undefined" ? undefined : window.rakazoDesktop;
}

let pageHeadReads = 0;

/**
 * The start of a page as this computer reads it, for a link the server was refused. Only the
 * desktop app can (a browser cannot read another site); anywhere else, or on an older desktop,
 * it is null and the server's card stays. Aborting `signal` stops the read on the desktop, so a
 * link pasted over another does not wait for a slot.
 */
export async function readPageHeadOnDesktop(
  url: string,
  signal: AbortSignal,
): Promise<{ head: string; contentType: string } | null> {
  const bridge = desktopBridge()?.pageHead;
  if (!bridge || signal.aborted) return null;
  const id = `page-head-${++pageHeadReads}`;
  const cancel = () => void bridge.cancel?.(id);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await bridge.read(url, id);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** The compact `code#state` form the manual paste flow already accepts. */
export function desktopOAuthCode(callback: RakazoDesktopOAuthCallback) {
  return callback.state === undefined ? callback.code : `${callback.code}#${callback.state}`;
}

/**
 * The authorize URL carries the attempt's PKCE state, so a captured code whose
 * state differs belongs to a different attempt — a popup left open by a
 * cancelled sign-in, say — and must not be spent on the current one.
 */
export function oauthStateOf(verificationUri: string): string | undefined {
  try {
    return new URL(verificationUri).searchParams.get("state") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Desktop sign-in redirects to a loopback URL the renderer never sees.
 * The main process captures the code there so the browser flow's
 * copy-and-paste step can be skipped. No-ops in a browser.
 *
 * Pass the attempt's state to ignore codes captured for any other attempt.
 * Providers whose authorize URL carries no state cannot be correlated, so
 * their codes are accepted as before.
 */
export function onDesktopOAuthCallback(
  listener: (code: string) => void,
  expectedState?: string,
): () => void {
  const oauth = desktopBridge()?.oauth;
  if (!oauth) return () => undefined;
  return oauth.onCallback((callback) => {
    if (expectedState !== undefined && callback.state !== expectedState) return;
    listener(desktopOAuthCode(callback));
  });
}

export function windowChromeKind(desktop?: RakazoDesktop): "spacer" | "darwin" | "controls" {
  if (!desktop) return "spacer";
  if (desktop.platform === "darwin") return "darwin";
  return "controls";
}
