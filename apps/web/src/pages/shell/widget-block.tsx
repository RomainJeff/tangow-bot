import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { buildWidgetDocument, parseWidgetHeightMessage } from "@rakazo/core/widget";
import { Button, Dialog, DialogClose, DialogContent, DialogTitle, Surface } from "@rakazo/ui-web";
import { Maximize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { fetchArtifactBytes } from "../../lib/artifact-open";

function WidgetFrame({
  html,
  theme,
  title,
  fullscreen = false,
}: {
  html: string;
  theme: "light" | "dark";
  title: string;
  fullscreen?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [navigated, setNavigated] = useState(false);
  const [height, setHeight] = useState(192);
  const [document] = useState(() => buildWidgetDocument({ html, theme }));
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ rakazoWidgetTheme: theme }, "*");
  }, [theme]);
  useEffect(() => {
    if (fullscreen) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const measured = parseWidgetHeightMessage(event.data);
      if (measured !== null) setHeight(Math.min(measured, 20_000));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fullscreen]);
  return (
    <iframe
      ref={frame}
      title={title}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      allow="fullscreen"
      srcDoc={document}
      loading="lazy"
      scrolling={fullscreen ? "auto" : "no"}
      hidden={navigated}
      onLoad={() => {
        loads.current += 1;
        if (loads.current > 1) setNavigated(true);
        else frame.current?.contentWindow?.postMessage({ rakazoWidgetTheme: theme }, "*");
      }}
      className={
        navigated
          ? "hidden"
          : fullscreen
            ? "h-full min-h-0 w-full flex-1 border-0"
            : "block w-full border-0"
      }
      style={fullscreen ? undefined : { height }}
    />
  );
}

export function WidgetBlockView({
  block,
  artifactTarget,
}: {
  block: Extract<MessageBlock, { kind: "widget" }>;
  artifactTarget: ArtifactTarget;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; html: string } | { status: "error" }
  >({ status: "loading" });
  const [expanded, setExpanded] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const botId = "botId" in artifactTarget ? artifactTarget.botId : undefined;
  const groupId = "groupId" in artifactTarget ? artifactTarget.groupId : undefined;
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const target: ArtifactTarget = botId !== undefined ? { botId } : { groupId: groupId! };
    void fetchArtifactBytes(target, block.artifactId).then(
      (bytes) => {
        if (!cancelled) setState({ status: "ready", html: new TextDecoder().decode(bytes) });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [botId, groupId, block.artifactId]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  if (state.status === "loading") return <Surface className="h-48 w-full" />;
  if (state.status === "error") {
    return (
      <Surface className="p-4 text-meta text-destructive">{t`Could not load this file.`}</Surface>
    );
  }
  return (
    <>
      <Surface className="group relative w-full overflow-hidden">
        <WidgetFrame key={block.artifactId} html={state.html} theme={theme} title={block.title} />
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label={t`Open in full screen`}
          onClick={() => setExpanded(true)}
          className="absolute end-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
        >
          <Maximize2 />
        </Button>
      </Surface>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[92dvh] w-[94vw] max-w-none flex-col overflow-hidden p-2 sm:max-w-none"
        >
          <div className="flex items-center justify-between gap-2 px-2">
            <DialogTitle className="text-meta">{block.title}</DialogTitle>
            <DialogClose aria-label={t`Close`} render={<Button variant="ghost" size="icon-sm" />}>
              <X />
            </DialogClose>
          </div>
          <WidgetFrame
            key={block.artifactId}
            html={state.html}
            theme={theme}
            title={block.title}
            fullscreen
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
