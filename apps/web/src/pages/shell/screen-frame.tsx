import { useLingui } from "@lingui/react/macro";
import { cn, Shimmer } from "@rakazo/ui-web";
import { LoaderCircle } from "lucide-react";
import { useRef } from "react";
import type { ScreenLinkHandlers } from "./use-screen-link";
import { useScreenLink } from "./use-screen-link";

function screenIframeSandbox(url: string) {
  try {
    return new URL(url, window.location.href).pathname.startsWith("/novnc/")
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}

function ScreenLinkOverlay({ view }: { view: "connecting" | "reconnecting" }) {
  const { t } = useLingui();
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 grid place-items-center p-2",
        view === "reconnecting" && "bg-overlay",
      )}
    >
      <span
        role="status"
        className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-full bg-card px-3.5 py-2 text-working text-muted-foreground shadow-floating"
      >
        <LoaderCircle
          aria-hidden
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
        />
        <Shimmer>{view === "connecting" ? t`Connecting…` : t`Reconnecting`}</Shimmer>
      </span>
    </div>
  );
}

/**
 * The bot's screen with its connection state on top. The frame is keyed by URL, so a new URL
 * is a new document that starts over at "Connecting…". Place it in a `relative` container.
 */
export function ScreenFrame({
  url,
  title,
  allow,
  interactive,
  handlers,
}: {
  url: string;
  title: string;
  allow: string;
  /** Whether the viewer may drive the screen once it is connected. */
  interactive: boolean;
  handlers: ScreenLinkHandlers;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { view, onLoad } = useScreenLink({ url, frameRef, handlers });
  if (view === "failed") return null;
  return (
    <>
      <iframe
        key={url}
        ref={frameRef}
        title={title}
        src={url}
        sandbox={screenIframeSandbox(url)}
        className="h-full w-full border-0 bg-black"
        allow={allow}
        onLoad={onLoad}
        style={{ pointerEvents: interactive && view === "none" ? "auto" : "none" }}
      />
      {view === "none" ? null : <ScreenLinkOverlay view={view} />}
    </>
  );
}
