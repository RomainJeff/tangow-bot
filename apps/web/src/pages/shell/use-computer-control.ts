import { useLingui } from "@lingui/react/macro";
import type { Bot, ComputerReleaseReason } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import {
  computerPanelAutoBoot,
  computerPanelAutoUsesBoot,
  computerTakeoverBlocked,
  userHoldsComputerControl,
} from "../../lib/thread-events";
import type { Panel } from "./layout";
import type { ComputerScreen } from "./use-computer-screen";
import type { Roster } from "./use-roster";
import type { ThreadStore } from "./use-thread-store";
import type { ThreadSync } from "./use-thread-sync";

/**
 * Starting, taking and handing back `bot`'s computer (the active bot's, or in a group the one
 * whose run waits for you), the active bot's teaching session, and the lifecycle that keeps an
 * open computer alive or closes it.
 */
export function useComputerControl({
  panel,
  roster,
  bot,
  runStatus,
  store,
  screen: computerScreen,
  sync,
}: {
  panel: Panel;
  roster: Roster;
  bot: Bot | undefined;
  /** The status of the run `bot`'s computer serves. */
  runStatus: string | undefined;
  store: ThreadStore;
  screen: ComputerScreen;
  sync: ThreadSync;
}) {
  const { t } = useLingui();
  const { active, activeBotId, inGroup } = roster;
  const { computer, taughtSkills, taughtSkillsBotId } = store;
  const { screenUrl, screenRequest, computerOpen, setComputerOpen, botIdRef } = computerScreen;
  const { setComputerError, setComputerErrorFromScreen, refreshComputerScreen } = computerScreen;
  const { refreshThread, refreshThreadRef } = sync;
  // A group's snapshot carries no computer: after a change of hands only the computer is read.
  const refreshAfterControl = (id: string) =>
    inGroup ? computerScreen.loadComputerStatus(id) : refreshThreadRef.current(id);
  const [booting, setBooting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [teachBusy, setTeachBusy] = useState(false);
  const autoBooted = useRef<string | null>(null);

  async function bootComputer({
    takeControl,
    overlay,
    force = false,
  }: {
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
  }) {
    if (!bot) return;
    const needsBoot = force || computer?.state !== "running" || !screenUrl;
    if (overlay && needsBoot) setBooting(true);
    setComputerError(null);
    setComputerErrorFromScreen(false);
    try {
      if (needsBoot) await rpc.computer.boot({ botId: bot.id });
      if (takeControl) await rpc.computer.takeover({ botId: bot.id });
      await refreshAfterControl(bot.id);
    } catch (error) {
      setComputerError(error instanceof Error ? error.message : t`Could not take control`);
      setComputerErrorFromScreen(false);
      throw error;
    } finally {
      setBooting(false);
    }
  }

  useEffect(() => {
    if (panel !== "computer") {
      autoBooted.current = null;
      return;
    }
    if (!active) return;
    const botId = active.id;
    let cancelled = false;
    void (async () => {
      // Refresh from the server first. A stale SSE "booting" snapshot used to
      // skip this effect, so an RPC takeover never showed "You have control".
      const snap = await refreshThread(botId).catch(() => null);
      if (cancelled || activeBotId.current !== botId) return;
      const state = snap?.computer?.state;
      let screen: string | null = null;
      if (state === "running") {
        const request = screenRequest.current + 1;
        screen = await refreshComputerScreen(botId);
        // A newer screen read owns the outcome; its null is not a missing screen.
        if (screenRequest.current !== request) return;
      }
      if (cancelled || activeBotId.current !== botId) return;
      const action = computerPanelAutoBoot(state, screen);
      if (action === "wait") {
        if (state === "running") autoBooted.current = botId;
        return;
      }
      if (action === "boot" && autoBooted.current === botId) return;
      autoBooted.current = botId;
      if (!computerPanelAutoUsesBoot(action)) return;
      await bootComputer({
        takeControl: false,
        overlay: action === "boot",
        force: true,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, active?.id]);

  useEffect(() => {
    setComputerOpen(false);
    setComputerError(null);
    setComputerErrorFromScreen(false);
  }, [bot?.id]);

  useEffect(() => {
    if (!computer?.busyBotName) {
      setComputerError(null);
      setComputerErrorFromScreen(false);
    }
  }, [computer?.busyBotName]);

  useEffect(() => {
    if (!computerOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setComputerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [computerOpen]);

  useEffect(() => {
    if ((panel !== "computer" && !computerOpen) || !bot || computer?.state !== "running") return;
    const ping = () => void rpc.computer.heartbeat({ botId: bot.id }).catch(() => undefined);
    ping();
    const timer = window.setInterval(ping, 60_000);
    return () => window.clearInterval(timer);
  }, [panel, computerOpen, bot?.id, computer?.state]);

  /**
   * Opens the full window to watch, at once: it shows Connecting… while the computer boots and a
   * fresh screen URL loads, so it never renders a cached one. `takeControl` (the Needs you card)
   * also takes the mouse and keyboard, and opens the window once that has landed.
   */
  async function openComputer({ takeControl = false }: { takeControl?: boolean } = {}) {
    if (!bot) return;
    const takeover =
      takeControl &&
      !userHoldsComputerControl(computer, bot.id) &&
      !computerTakeoverBlocked(computer, runStatus);
    setOpening(true);
    if (!takeover) setComputerOpen(true);
    try {
      await bootComputer({
        takeControl: takeover,
        overlay: takeover || computer?.state !== "running",
        force: computer?.state !== "running",
      });
      await refreshComputerScreen(bot.id, { visible: true });
      // Watching opened the window already; reopening here would undo a close made while it loaded.
      if (takeover) setComputerOpen(true);
    } catch {
      // computerError already set in bootComputer
    } finally {
      setOpening(false);
    }
  }

  async function takeComputerControl() {
    if (!bot) return;
    try {
      await bootComputer({ takeControl: true, overlay: false });
      // The screen URL changes with control: wait for the interactive one before the button settles.
      await refreshComputerScreen(bot.id, { visible: true });
    } catch {
      // computerError already set in bootComputer
    }
  }

  const releaseComputer = useCallback(
    async (reason?: ComputerReleaseReason) => {
      const botId = botIdRef.current;
      if (!botId) return;
      try {
        await rpc.computer.release({ botId, reason });
        if (botIdRef.current !== botId) return;
        setComputerOpen(false);
        await refreshAfterControl(botId).catch(() => undefined);
      } catch {
        if (botIdRef.current !== botId) return;
        setComputerError(t`Could not continue`);
        setComputerErrorFromScreen(false);
      }
    },
    [t, inGroup],
  );

  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = taughtSkills.find(
      (skill) => skill.status === "recording" && taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      setComputerOpen(false);
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, taughtSkills, taughtSkillsBotId]);
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await rpc.skills.list({ botId: id });
    if (activeBotId.current !== id) return;
    store.setTaughtSkills(skills);
    store.setTaughtSkillsBotId(id);
  }, []);

  return {
    booting,
    opening,
    openComputer,
    takeComputerControl,
    releaseComputer,
    teachBusy,
    stopTeaching,
    refreshActiveTeaching,
  };
}
