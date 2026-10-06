import type { ScreenLinkView } from "@rakazo/core";
import { createScreenLink, screenLinkChannel } from "@rakazo/core";
import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface ScreenLinkHandlers {
  /** Read the status and reuse or replace the screen URL. */
  onAdjudicate(): void;
  /** Force a new screen URL. */
  onReload(): void;
  /** The link gave up; show the error and its retry. */
  onFailed(): void;
}

export function useScreenLink({
  url,
  frameRef,
  handlers,
}: {
  url: string;
  frameRef: RefObject<HTMLIFrameElement | null>;
  handlers: ScreenLinkHandlers;
}) {
  const [view, setView] = useState<ScreenLinkView>("connecting");
  const linkRef = useRef<ReturnType<typeof createScreenLink> | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Layout timing: the link must exist before the new frame can fire its first `load`.
  useLayoutEffect(() => {
    const link = createScreenLink({
      onAdjudicate: () => handlersRef.current.onAdjudicate(),
      onReload: () => handlersRef.current.onReload(),
      onView(next) {
        setView(next);
        if (next === "failed") handlersRef.current.onFailed();
      },
    });
    linkRef.current = link;
    let hiddenAt: number | null = null;
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      link.hidden();
    }
    link.url(url);

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        hiddenAt ??= Date.now();
        link.hidden();
        return;
      }
      if (hiddenAt === null) return;
      const hiddenForMs = Date.now() - hiddenAt;
      hiddenAt = null;
      link.returned(hiddenForMs);
    };
    // The sandboxed frame has an opaque origin, so the sending window is the only proof of origin.
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow;
      if (frame && event.source === frame) link.message(event.data);
    };
    document.addEventListener("visibilitychange", onVisibility);
    const listening = screenLinkChannel(url) === "embed";
    if (listening) window.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (listening) window.removeEventListener("message", onMessage);
      link.dispose();
      linkRef.current = null;
    };
  }, [url, frameRef]);

  const onLoad = useCallback(() => linkRef.current?.loaded(), []);
  return { view, onLoad };
}
