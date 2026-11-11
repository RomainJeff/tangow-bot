import { Trans, useLingui } from "@lingui/react/macro";
import type { HeldScreenUrl } from "@tangow/core";
import { Button } from "@tangow/ui-web";
import { useEffect, useRef, useState } from "react";
import { cachedScreenUrl, loadComputerScreen } from "../../lib/computer-screen";
import { rpc } from "../../lib/rpc";
import { clearBusyWhileWaitingTakeover, userHoldsComputerControl } from "../../lib/thread-events";
import type { Panel } from "./layout";
import type { ScreenLinkHandlers } from "./screen-frame";
import type { ThreadStore } from "./use-thread-store";

function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(window.location.href);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) {
      return null;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * `botId`'s computer screen: the URL it embeds, its errors, the full viewer's
 * open state and viewport, and the reads that keep them current.
 */
export function useComputerScreen({
  panel,
  botId: computerBotId,
  store,
}: {
  panel: Panel;
  /** The open bot's, or in a group the bot whose run waits for you to take its screen. */
  botId: string | undefined;
  store: ThreadStore;
}) {
  const { t } = useLingui();
  const botIdRef = useRef(computerBotId);
  botIdRef.current = computerBotId;
  const { computer, computerRef, commitComputer, computerCacheRef, cacheComputerFor, snapshotRef } =
    store;
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const [computerViewport, setComputerViewport] = useState<{
    height: number;
    offsetTop: number;
  } | null>(null);
  const [computerError, setComputerError] = useState<string | null>(null);
  // Screen-load failures can sit beside a still-valid embed URL; boot and
  // takeover failures must stay visible even when a URL remains.
  const [computerErrorFromScreen, setComputerErrorFromScreen] = useState(false);
  // The screen URL whose connection gave up; it stays failed until it is replaced or retried.
  const [failedScreenUrl, setFailedScreenUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!computerOpen) {
      setComputerViewport(null);
      return;
    }
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      setComputerViewport({ height: viewport.height, offsetTop: viewport.offsetTop });
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, [computerOpen]);
  const computerShown = panel === "computer" || computerOpen;
  const computerVisible = useRef(false);
  computerVisible.current = computerShown;
  const [computerWasShown, setComputerWasShown] = useState(computerShown);
  if (computerShown !== computerWasShown) {
    setComputerWasShown(computerShown);
    // A URL kept while the screen was closed may be past its capability; never open it.
    if (computerShown && computerBotId) {
      setScreenUrl(
        cachedScreenUrl(
          computerCacheRef.current.get(computerBotId)?.screen,
          computerRef.current,
          Date.now(),
        ),
      );
    }
  }
  const screenRequest = useRef(0);
  const screenReads = useRef(new Map<string, Promise<HeldScreenUrl>>());
  const computerStatusRequest = useRef(0);

  // `visible` is for a caller about to open the viewer: `computerVisible` still reads the old render.
  async function refreshComputerScreen(id: string, { force = false, visible = false } = {}) {
    const isVisible = () => visible || computerVisible.current;
    if (!isVisible()) return null;
    const request = ++screenRequest.current;
    return loadComputerScreen({
      botId: id,
      status: botIdRef.current === id ? computerRef.current : null,
      held: computerCacheRef.current.get(id)?.screen,
      force,
      reads: screenReads.current,
      load: () => rpc.computer.screenUrl({ botId: id }),
      isCurrent: () => request === screenRequest.current && botIdRef.current === id && isVisible(),
      commit: (screen, held) => {
        setScreenUrl(screen.url);
        setComputerError(screen.error);
        setComputerErrorFromScreen(Boolean(screen.error));
        cacheComputerFor(id, { screen: held });
      },
      fallbackError: t`Could not connect to the computer screen`,
    });
  }

  /** A group thread carries no computer: its card's bot's is read on its own. */
  async function loadComputerStatus(id: string) {
    const request = ++computerStatusRequest.current;
    const status = await rpc.computer.status({ botId: id });
    if (request !== computerStatusRequest.current || botIdRef.current !== id) return false;
    const reconciled = clearBusyWhileWaitingTakeover(status, snapshotRef.current?.run?.status);
    commitComputer(reconciled);
    cacheComputerFor(id, { computer: reconciled });
    return true;
  }

  // Events carry no screen stamp, so the screen decision waits for the server status.
  async function refreshComputerStatus(id: string) {
    if (!computerVisible.current) return;
    if (await loadComputerStatus(id)) await refreshComputerScreen(id);
  }

  /** A bot switch drops pending screen reads and paints the bot's last-known computer at once. */
  function showCachedComputer(botId: string) {
    screenRequest.current += 1;
    setComputerError(null);
    setComputerErrorFromScreen(false);
    const cached = computerCacheRef.current.get(botId);
    if (cached) {
      // Paint the last-known computer instantly; refreshThread/refreshComputerScreen
      // still run and reconcile with fresh data in the background.
      setScreenUrl(cachedScreenUrl(cached.screen, cached.computer, Date.now()));
      commitComputer(cached.computer);
    } else {
      setScreenUrl(null);
    }
  }

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl);
  const hasControl = userHoldsComputerControl(computer, computerBotId);
  const hideScreenLoadError = computerErrorFromScreen && Boolean(embeddedScreenUrl);
  const screenFailed = embeddedScreenUrl !== null && embeddedScreenUrl === failedScreenUrl;
  const computerScreenErrorText =
    computerError && !hideScreenLoadError
      ? computerError
      : screenFailed
        ? t`Could not connect to the computer screen`
        : null;
  const computerScreenError =
    computerScreenErrorText !== null ? (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 text-center text-sm">
        <p className="text-destructive">{computerScreenErrorText}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => computerBotId && void retryScreen(computerBotId)}
        >
          <Trans>Retry screen</Trans>
        </Button>
      </div>
    ) : null;

  async function retryScreen(id: string) {
    await refreshComputerScreen(id, { force: true });
    if (botIdRef.current === id) setFailedScreenUrl(null);
  }

  const screenLink: ScreenLinkHandlers = {
    onAdjudicate() {
      const botId = botIdRef.current;
      if (botId) void refreshComputerStatus(botId).catch(() => undefined);
    },
    onReload() {
      const botId = botIdRef.current;
      if (botId) void refreshComputerScreen(botId, { force: true }).catch(() => null);
    },
    onFailed(url) {
      setFailedScreenUrl(url);
    },
  };

  return {
    screenUrl,
    screenRequest,
    computerOpen,
    setComputerOpen,
    computerViewport,
    setComputerError,
    setComputerErrorFromScreen,
    refreshComputerScreen,
    loadComputerStatus,
    refreshComputerStatus,
    showCachedComputer,
    botIdRef,
    embeddedScreenUrl,
    hasControl,
    computerScreenError,
    screenLink,
  };
}

export type ComputerScreen = ReturnType<typeof useComputerScreen>;
