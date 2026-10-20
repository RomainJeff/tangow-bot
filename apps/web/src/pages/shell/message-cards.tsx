import { Trans, useLingui } from "@lingui/react/macro";
import { LinkMentionGlyph } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  FramedBlock,
  LinkPreviewPicture,
  Surface,
} from "@rakazo/ui-web";
import { ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SuccessPop } from "../../components/ai/primitives";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { chartViewport } from "../../lib/chart-viewport";
import { connectMcpOauth } from "../../lib/mcp-connect";
import { rpc } from "../../lib/rpc";
import { useArtifactImageSrc } from "./use-artifact-image-src";

export function ChoiceCard({
  botId,
  block,
  onBotChanged,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
  onBotChanged: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const dismissed = locallyDismissed || block.answerId === "_dismissed";

  async function choose(optionId: string) {
    setPending(true);
    setPendingOptionId(optionId);
    setError(null);
    try {
      await rpc.onboarding.choose({ botId, optionId });
      await onBotChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save this choice`);
      setPending(false);
      setPendingOptionId(null);
    }
  }

  async function dismiss() {
    setPending(true);
    setError(null);
    try {
      await rpc.onboarding.dismissFocus({ botId });
      setLocallyDismissed(true);
      void onBotChanged().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not dismiss`);
      setPending(false);
    }
  }

  if (dismissed) return null;

  const answeredOption = block.answerId
    ? block.options.find((option) => option.id === block.answerId)
    : undefined;

  return (
    <FramedBlock
      question={block.question}
      consequence={block.subtitle}
      answered={
        block.answerId ? t`Answered: ${answeredOption?.label ?? block.answerId}` : undefined
      }
      actions={
        !block.answerId ? (
          <Button
            type="button"
            variant="tertiary"
            size="capsule"
            disabled={pending}
            onClick={() => void dismiss()}
          >
            <Trans>Dismiss</Trans>
          </Button>
        ) : undefined
      }
    >
      <div data-testid="ask-options" className="flex flex-wrap gap-2">
        {block.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant={pendingOptionId === option.id ? "capsule" : "quickReply"}
            size="quickReply"
            aria-pressed={pendingOptionId === option.id}
            disabled={pending}
            onClick={() => void choose(option.id)}
          >
            {option.letter}. {option.label}
          </Button>
        ))}
      </div>
      {error ? <p className="mt-2 text-meta text-destructive">{error}</p> : null}
    </FramedBlock>
  );
}

export function AppConnectCard({
  botId,
  block,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "app_connect" }>;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [localStatus, setLocalStatus] = useState<"pending" | "connected">(block.status);
  const [error, setError] = useState<string | null>(null);
  const connectionAttempt = useRef<AbortController | null>(null);
  const status = block.status === "connected" ? "connected" : localStatus;
  useEffect(() => () => connectionAttempt.current?.abort(), []);

  async function authorize() {
    connectionAttempt.current?.abort();
    const controller = new AbortController();
    connectionAttempt.current = controller;
    setBusy(true);
    setError(null);
    try {
      const started = await rpc.connections.begin({
        connectorId: block.connectorId,
        provider: block.provider,
        displayName: block.name,
      });
      if (started.authorizationUrl) {
        window.open(started.authorizationUrl, "rakazo-app-connect", "popup,width=560,height=720");
      }
      for (let i = 0; i < 60; i += 1) {
        if (controller.signal.aborted) return;
        const row = await rpc.connections
          .complete({ connectionId: started.connectionId })
          .catch(() => undefined);
        if (row?.status === "connected") {
          if (controller.signal.aborted) return;
          setLocalStatus("connected");
          await rpc.onboarding
            .appConnected({ botId, provider: block.provider, connectorId: block.connectorId })
            .catch(() => undefined);
          return;
        }
        await abortableDelay(2_000, controller.signal);
      }
      if (!controller.signal.aborted) setError(t`Authorization timed out. Please try again.`);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : t`Could not authorize this app`);
      }
    } finally {
      if (connectionAttempt.current === controller) {
        connectionAttempt.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <Surface
      role="group"
      aria-label={t`${block.name} connection`}
      className="w-[min(420px,80%)] px-4 py-3.5"
    >
      <div className="flex items-center gap-3.5">
        {block.logo ? (
          <img
            src={block.logo}
            alt=""
            className="h-10 w-10 rounded-row bg-well object-contain p-1"
          />
        ) : (
          <span className="grid h-10 w-10 place-items-center rounded-row bg-well text-meta text-foreground">
            {block.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-author font-medium text-foreground">{block.name}</span>
          <span className="block truncate text-meta text-muted-foreground">
            {block.description}
          </span>
        </span>
        {status === "connected" ? (
          <SuccessPop label={t`Connected`} />
        ) : (
          <Button
            variant="secondary"
            className="rounded-full hover:border-border hover:bg-accent hover:text-foreground"
            disabled={busy}
            onClick={() => void authorize()}
          >
            {busy ? t`Waiting…` : t`Authorize`}
          </Button>
        )}
      </div>
      {error ? <p className="mt-2 text-time text-destructive">{error}</p> : null}
    </Surface>
  );
}

function ChartCanvas({
  spec,
  data,
  width,
  height,
}: {
  spec: Record<string, unknown>;
  data: unknown[];
  width: number;
  height?: number;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    title?: string;
    swatches: { label: string; color: string }[];
  }>({ swatches: [] });
  useEffect(() => {
    let cancelled = false;
    // Plot loads lazily so threads without charts never pay for the library.
    void (async () => {
      try {
        const { buildPlotParts } = await import("@rakazo/core/plot");
        if (cancelled || !ref.current) return;
        // Hover inspection by default: give the first mark a tooltip unless
        // the spec already asks for one somewhere.
        const marks = Array.isArray((spec as { marks?: unknown[] }).marks)
          ? ((spec as { marks: { options?: Record<string, unknown> }[] }).marks ?? [])
          : [];
        const hasTip = marks.some((mark) => mark.options && "tip" in mark.options);
        const liveSpec = hasTip
          ? spec
          : {
              ...spec,
              marks: marks.map((mark, index) =>
                index === 0 ? { ...mark, options: { ...(mark.options ?? {}), tip: true } } : mark,
              ),
            };
        const parts = buildPlotParts(liveSpec as never, data, document, { width, height });
        setMeta({ title: parts.title, swatches: parts.swatches });
        setError(null);
        ref.current.replaceChildren(parts.plotted);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t`Could not render chart`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec, data, width, height, t]);
  if (error)
    return (
      <div className="text-meta text-destructive">
        <Trans>Chart failed to render: {error}</Trans>
      </div>
    );
  return (
    <div className="text-foreground/75">
      {meta.title ? (
        <div className="mb-1 text-row-name font-semibold text-foreground">{meta.title}</div>
      ) : null}
      {meta.swatches.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
          {meta.swatches.map((swatch) => (
            <span
              key={swatch.label}
              className="flex items-center gap-1.5 text-time text-muted-foreground"
            >
              {/* Series colours are data-driven and intentionally distinct. */}
              <span
                className="h-[10px] w-[10px] rounded-[3px]"
                style={{ background: swatch.color }}
              />
              {swatch.label}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={ref} className="[&_svg]:max-w-full" />
    </div>
  );
}

type McpApprovalState = "pending" | "connecting" | "connected" | "dismissed";

/** Approval card for an agent-created MCP server: the user completes browser
 * OAuth (or confirms no authorization is needed) without leaving the chat. */
export function McpApprovalCard({
  botId,
  name,
  serverId,
  transport,
  endpoint,
  needsOAuth,
}: {
  botId: string | undefined;
  name: string;
  serverId: string;
  transport: string;
  endpoint: string | null;
  needsOAuth: boolean;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<McpApprovalState>("pending");
  const [error, setError] = useState<string | null>(null);

  async function authorize() {
    if (!botId) {
      setError(t`This server cannot be assigned without a bot.`);
      return;
    }
    setState("connecting");
    setError(null);
    try {
      if (needsOAuth) {
        const result = await connectMcpOauth(serverId);
        if (result === "cancelled") {
          setState("pending");
          return;
        }
      }
      await rpc.mcp.assignments.approve({ botId, serverId });
      setState("connected");
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not approve this server`);
      setState("pending");
    }
  }

  const summary = endpoint ?? `stdio · ${transport}`;
  return (
    <Surface className="max-w-[74%] p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-row bg-well text-time text-foreground">
          M
        </span>
        <span className="text-author font-medium text-foreground">
          <Trans>Connect MCP server “{name}”</Trans>
        </span>
      </div>
      <p className="mt-1.5 truncate text-time text-muted-foreground">{summary}</p>
      {state === "pending" || state === "connecting" ? (
        <>
          <p className="mt-2 text-meta text-foreground">
            {needsOAuth
              ? t`Authorize this server so agents can use its tools. A popup opens.`
              : t`Approve this server to let your agent use its tools.`}
          </p>
          {error ? <p className="mt-2 text-time text-destructive">{error}</p> : null}
          <div className="mt-3 flex gap-2">
            <Button
              className="rounded-full"
              disabled={state === "connecting"}
              onClick={() => void authorize()}
            >
              {state === "connecting" ? t`Connecting…` : needsOAuth ? t`Authorize` : t`Approve`}
            </Button>
            <Button
              variant="secondary"
              className="rounded-full"
              onClick={() => setState("dismissed")}
            >
              <Trans>Not now</Trans>
            </Button>
          </div>
        </>
      ) : null}
      {state === "connected" ? (
        <div className="mt-3">
          <SuccessPop label={t`Connected. Its tools are available from your next message.`} />
        </div>
      ) : null}
      {state === "dismissed" ? (
        <p className="mt-2 text-meta text-muted-foreground">
          <Trans>Dismissed. Reconnect anytime from MCP settings.</Trans>
        </p>
      ) : null}
    </Surface>
  );
}

export function ChartBlockView({
  name,
  spec,
  data,
}: {
  name: string;
  spec: Record<string, unknown>;
  data: unknown[];
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    if (!expanded) return;
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [expanded]);
  const expandedViewport = chartViewport(viewport.width, viewport.height);
  return (
    <>
      <Surface className="group relative max-w-[74%] p-4">
        <ChartCanvas spec={spec} data={data} width={520} />
        <Button
          variant="outline"
          size="xs"
          onClick={() => setExpanded(true)}
          className="absolute end-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trans>Expand</Trans>
        </Button>
      </Surface>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[92vh] w-[min(1320px,94vw)] max-w-none overflow-auto p-8 sm:max-w-none"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-meta font-normal text-muted-foreground">
              {name}
            </DialogTitle>
            <DialogClose
              aria-label={t`Close chart`}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <X />
            </DialogClose>
          </div>
          <ChartCanvas
            spec={spec}
            data={data}
            width={expandedViewport.width}
            height={expandedViewport.height}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function LinkPreviewImage({
  target,
  artifactId,
  fit,
}: {
  target: ArtifactTarget;
  artifactId: string;
  /** `contain` for a site icon: drawn whole inside the frame. */
  fit?: "contain";
}) {
  const { container, src, failed } = useArtifactImageSrc(target, artifactId);
  return (
    <div
      ref={container}
      className={`absolute inset-0 overflow-hidden ${failed ? "grid place-items-center" : ""}`}
    >
      {src ? (
        <LinkPreviewPicture src={src} fit={fit} />
      ) : failed ? (
        <ImageIcon className="size-5 text-muted-foreground" strokeWidth={1.7} aria-hidden />
      ) : null}
    </div>
  );
}

/**
 * The site icon of a link mention, read from the thread's artifacts like a card's picture, never
 * a remote URL. The link glyph stands in when the artifact cannot be read or is not an image.
 */
export function LinkMentionIcon({
  target,
  artifactId,
}: {
  target: ArtifactTarget;
  artifactId: string;
}) {
  const { container, src, failed, onImageError } = useArtifactImageSrc<HTMLSpanElement>(
    target,
    artifactId,
  );
  if (failed) return <LinkMentionGlyph />;
  return (
    <span ref={container}>{src ? <img src={src} alt="" onError={onImageError} /> : null}</span>
  );
}

export function ArtifactImage({
  target,
  artifactId,
  name,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const { container, src } = useArtifactImageSrc(target, artifactId);

  return (
    <div ref={container}>
      {src ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="max-w-[240px] overflow-hidden rounded-card"
        >
          <img src={src} alt={name} className="max-h-48 w-full object-cover" />
        </button>
      ) : (
        <Surface className="px-4 py-3 text-meta text-muted-foreground">{name}</Surface>
      )}
      {src ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            showCloseButton={false}
            className="w-auto max-w-none bg-transparent p-0 shadow-none sm:max-w-none"
          >
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <DialogClose
              aria-label={t`Close image preview`}
              render={<Button variant="ghost" size="icon-sm" className="absolute end-2 top-2" />}
            >
              <X />
            </DialogClose>
            <img
              src={src}
              alt={name}
              className="max-h-[85vh] max-w-[90vw] rounded-card object-contain"
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
