import type { ScreenLink } from "@rakazo/core";
import { isScreenDocumentUrl, screenNavigationAllowed } from "@rakazo/core";
import type { AppStateStatus } from "react-native";
import type { WebViewMessageEvent } from "react-native-webview";

/**
 * The WebView props that feed a screen link. `originWhitelist` stays open on purpose: a URL it
 * rejects is handed to Safari, so navigation is enforced here and only here.
 */
export function screenWebViewProps(
  link: Pick<ScreenLink, "message" | "loaded">,
  screenUrl: string,
) {
  return {
    originWhitelist: ["*"],
    onShouldStartLoadWithRequest: (request: { url: string }) =>
      screenNavigationAllowed(request.url, screenUrl),
    onMessage: (event: WebViewMessageEvent) => {
      const { url, data } = event.nativeEvent;
      if (isScreenDocumentUrl(url, screenUrl)) link.message(data);
    },
    onLoadEnd: () => link.loaded(),
  };
}

/** Anything but `active` hides the screen; coming back reports how long it was away. */
export function trackScreenVisibility(
  link: Pick<ScreenLink, "hidden" | "returned">,
  subscribe: (listener: (state: AppStateStatus) => void) => () => void,
  now: () => number = Date.now,
): () => void {
  let hiddenAt: number | null = null;
  return subscribe((state) => {
    if (state !== "active") {
      if (hiddenAt !== null) return;
      hiddenAt = now();
      link.hidden();
      return;
    }
    if (hiddenAt === null) return;
    const hiddenForMs = now() - hiddenAt;
    hiddenAt = null;
    link.returned(hiddenForMs);
  });
}

/** What a screen link may ask the host: a status read that reuses the URL, or a new one. */
export function screenLinkEffects(refresh: (input: { force: boolean }) => Promise<unknown>) {
  const run = (force: boolean) => void refresh({ force }).catch(() => undefined);
  return { onAdjudicate: () => run(false), onReload: () => run(true) };
}
