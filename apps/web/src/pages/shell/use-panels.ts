import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "../../lib/use-media-query";
import type { BotPageView, Panel } from "./layout";
import { pageBotOf, panelIsOpen, panelSizeFor } from "./layout";
import type { Roster } from "./use-roster";

/** Which side panel is open, the bot page it shows, and whether it lies over the thread. */
export function usePanels({ bots, archivedBots, active, activeGroup }: Roster) {
  const [panel, setPanel] = useState<Panel>(null);
  const [botPage, setBotPage] = useState<BotPageView>({ tab: "settings", detail: null });
  const botPageRef = useRef(botPage);
  botPageRef.current = botPage;
  // An archived bot picked from the sidebar, whose page shows instead of the thread's bot.
  const [pickedBotId, setPickedBotId] = useState<string | null>(null);
  const showBotPage = useCallback((view: BotPageView) => {
    setPickedBotId(null);
    setBotPage(view);
    setPanel("bot");
  }, []);
  const showArchivedBotPage = useCallback((botId: string) => {
    setPickedBotId(botId);
    setBotPage({ tab: "activity", detail: null });
    setPanel("bot");
  }, []);
  const panelCoversThread = useRef(false);
  const pageBot = pageBotOf(pickedBotId, bots, archivedBots, active);

  // An open editor belongs to the bot it was opened on; the next bot's page
  // opens on its tab instead of widening the panel and taking focus.
  useEffect(() => {
    setBotPage((view) => (view.detail ? { ...view, detail: null } : view));
  }, [active?.id]);

  // A routine open in the panel belongs to the bot that was showing: a switch closes it.
  useEffect(() => {
    const kind = botPageRef.current.detail?.kind;
    if (kind !== "routine" && kind !== "routine-new") return;
    setBotPage({ tab: "routines", detail: null });
    setPanel((current) => (current === "bot" ? null : current));
  }, [active?.id]);

  // Below `lg` the panel is full width over the thread instead of reflowing
  // beside it (see `lg:pe-panel` in the shell's main), so it also covers the header and
  // composer without removing them from the tab order unless we do it here.
  const isDesktopWidth = useMediaQuery("(min-width: 1024px)");
  // The wide panel only sits beside the thread from `xl`; narrower, it lies over it.
  const isWideDesktopWidth = useMediaQuery("(min-width: 1280px)");
  const panelOpen = panelIsOpen(panel, panel === "bot" ? pageBot : active, activeGroup);
  const panelSize = panelSizeFor(panel, botPage);
  const panelCoversColumn =
    panelOpen && (!isDesktopWidth || (panelSize === "wide" && !isWideDesktopWidth));
  panelCoversThread.current = panelCoversColumn;

  return {
    panel,
    setPanel,
    botPage,
    setBotPage,
    pickedBotId,
    setPickedBotId,
    showBotPage,
    showArchivedBotPage,
    pageBot,
    panelCoversThread,
    panelOpen,
    panelSize,
    panelCoversColumn,
  };
}

export type Panels = ReturnType<typeof usePanels>;
