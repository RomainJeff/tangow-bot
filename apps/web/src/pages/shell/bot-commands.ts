import type { Bot, ComputerMode } from "@rakazo/contracts";
import { createAnswerOrder } from "@rakazo/core";
import type { Dispatch, SetStateAction } from "react";
import { useMemo, useRef } from "react";
import { rpc } from "../../lib/rpc";

export type UpdateBotPatch = Omit<Parameters<typeof rpc.bots.update>[0], "botId">;

export type BotAction = "duplicate" | "export" | "clear" | "archive" | "delete";

/** Everything the bot page may ask of the shell. The shell stays the one owner of `bots`. */
export interface BotCommands {
  /** Writes the patch, then merges the returned bot into the roster by id. */
  updateBot(botId: string, patch: UpdateBotPatch): Promise<Bot>;
  /** Its own call, never chained with `updateBot`: the server refuses it while the bot runs. */
  setComputer(botId: string, mode: ComputerMode): Promise<Bot>;
  /** The lifecycle actions the sidebar menu already runs, with the same confirmations. */
  botAction(botId: string, action: BotAction): void;
}

export interface BotCommandDeps {
  setBots: Dispatch<SetStateAction<Bot[]>>;
  /** Drops a roster refresh already in flight, which would carry the bot as it was before a write. */
  invalidateBotsRefresh: () => void;
  botAction: BotCommands["botAction"];
}

export function useBotCommands(deps: BotCommandDeps): BotCommands {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  // Per bot, what a late answer may still put back.
  const order = useRef(createAnswerOrder()).current;

  return useMemo<BotCommands>(() => {
    async function writeBot(
      botId: string,
      sent: readonly string[],
      write: () => Promise<Bot>,
    ): Promise<Bot> {
      const request = order.next();
      const bot = await write();
      const merge = order.write(botId, request, sent, bot);
      if (merge) {
        depsRef.current.invalidateBotsRefresh();
        depsRef.current.setBots((list) =>
          list.map((item) => (item.id === botId ? merge(item) : item)),
        );
      }
      return bot;
    }

    return {
      updateBot: (botId, patch) =>
        writeBot(botId, Object.keys(patch), () => rpc.bots.update({ botId, ...patch })),
      setComputer: (botId, mode) =>
        writeBot(botId, ["computerMode"], () => rpc.bots.setComputer({ botId, mode })),
      botAction: (botId, action) => depsRef.current.botAction(botId, action),
    };
  }, [order]);
}

/** Saves the bot's export manifest as a JSON file. */
export async function downloadBotExport(botId: string, name: string): Promise<void> {
  const manifest = await rpc.export.bot({ botId });
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
  link.click();
  URL.revokeObjectURL(url);
}
