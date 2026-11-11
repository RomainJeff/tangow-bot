import type { ScreenLink, ScreenLinkView } from "@tangow/core";
import { createScreenLink } from "@tangow/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { screenWebViewProps, trackScreenVisibility } from "./screen-link";

/** One screen link per mounted WebView and URL; the caller remounts the WebView to start over. */
export function useScreenLink(
  screenUrl: string,
  effects: { onAdjudicate: () => void; onReload: () => void },
) {
  const [view, setView] = useState<ScreenLinkView>("connecting");
  const linkRef = useRef<ScreenLink | null>(null);
  const effectsRef = useRef(effects);
  effectsRef.current = effects;

  useEffect(() => {
    const link = createScreenLink({
      onAdjudicate: () => effectsRef.current.onAdjudicate(),
      onReload: () => effectsRef.current.onReload(),
      onView: setView,
    });
    linkRef.current = link;
    link.url(screenUrl);
    const stopTracking = trackScreenVisibility(link, (listener) => {
      const subscription = AppState.addEventListener("change", listener);
      return () => subscription.remove();
    });
    return () => {
      stopTracking();
      link.dispose();
      linkRef.current = null;
    };
  }, [screenUrl]);

  const webViewProps = useMemo(
    () =>
      screenWebViewProps(
        {
          message: (data) => linkRef.current?.message(data),
          loaded: () => linkRef.current?.loaded(),
        },
        screenUrl,
      ),
    [screenUrl],
  );
  return { view, webViewProps };
}
