import type { ComputerMode } from "@tangow/contracts";
import { normalizeCreateBotProfile } from "@tangow/contracts";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef } from "react";
import type { NavigateFunction } from "react-router-dom";
import { scheduleFocusPrompt } from "../../lib/focus-prompt";
import { rpc } from "../../lib/rpc";
import type { GroupInput } from "../GroupPanel";
import type { Panel } from "./layout";
import type { Roster } from "./use-roster";

/**
 * Creates a bot or a group and opens it. A new bot then asks what to focus on,
 * unless the person leaves it or writes to it first.
 */
export function useCreateChat({
  roster,
  navigate,
  setPanel,
}: {
  roster: Roster;
  navigate: NavigateFunction;
  setPanel: Dispatch<SetStateAction<Panel>>;
}) {
  const { active, activeBotId, botsRef, setBots, setGroups, refreshBots } = roster;
  const focusPromptAbortRef = useRef<AbortController | null>(null);
  const focusPromptBotIdRef = useRef<string | null>(null);

  function cancelFocusPrompt() {
    focusPromptAbortRef.current?.abort();
    focusPromptAbortRef.current = null;
    focusPromptBotIdRef.current = null;
  }

  function cancelFocusPromptFor(botId: string | undefined) {
    if (botId && focusPromptBotIdRef.current === botId) {
      cancelFocusPrompt();
    }
  }

  useEffect(() => {
    if (focusPromptBotIdRef.current && focusPromptBotIdRef.current !== active?.id) {
      cancelFocusPrompt();
    }
  }, [active?.id]);

  useEffect(() => () => cancelFocusPrompt(), []);

  async function createGroup(input: GroupInput) {
    const group = await rpc.groups.create(input);
    setGroups((current) =>
      current.some((item) => item.id === group.id) ? current : [group, ...current],
    );
    navigate(`/app/g/${group.id}`);
    setPanel(null);
    await refreshBots().catch(() => undefined);
  }

  async function createBot(input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) {
    const isFirstBot = botsRef.current.length === 0;
    const bot = await rpc.bots.create({
      ...normalizeCreateBotProfile(input),
      notifyOnFinish: true,
      computerMode: input.computerMode,
    });
    setBots((current) =>
      current.some((item) => item.id === bot.id) ? current : [bot, ...current],
    );
    navigate(`/app/${bot.id}`);
    setPanel(null);
    // Register cancellation before awaiting start so leaving the bot during
    // startup cannot miss the abort and still schedule a late focus card.
    cancelFocusPrompt();
    const controller = new AbortController();
    focusPromptAbortRef.current = controller;
    focusPromptBotIdRef.current = bot.id;
    const started = await rpc.onboarding
      .start({ botId: bot.id })
      .then(() => true)
      .catch(() => false);
    if (!started || controller.signal.aborted || focusPromptBotIdRef.current !== bot.id) {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
      await refreshBots().catch(() => undefined);
      return;
    }
    void scheduleFocusPrompt({
      immediate: isFirstBot,
      signal: controller.signal,
      prompt: async () => {
        if (focusPromptBotIdRef.current !== bot.id || activeBotId.current !== bot.id) return;
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      },
    }).finally(() => {
      if (focusPromptAbortRef.current === controller) {
        focusPromptAbortRef.current = null;
        focusPromptBotIdRef.current = null;
      }
    });
    await refreshBots().catch(() => undefined);
  }

  return { createBot, createGroup, cancelFocusPromptFor };
}
