import type { Bot, ComputerMode, Routine, RunActivityRow } from "@rakazo/contracts";
import { createAnswerOrder, type RoutinePayload } from "@rakazo/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useMemo, useRef } from "react";
import { localTimezone } from "../../lib/local-timezone";
import { rpc } from "../../lib/rpc";
import { threadJumpLocation } from "./layout";

export type UpdateBotPatch = Omit<Parameters<typeof rpc.bots.update>[0], "botId">;

export type RoutinePatch = Omit<Parameters<typeof rpc.routines.update>[0], "routineId">;

export type BotAction = "duplicate" | "export" | "clear" | "archive" | "restore" | "delete";

/** Everything the bot page may ask of the shell. The shell stays the one owner of `bots` and `routines`. */
export interface BotCommands {
  /** Writes the patch, then merges the returned bot into the roster by id. */
  updateBot(botId: string, patch: UpdateBotPatch): Promise<Bot>;
  /** Its own call, never chained with `updateBot`: the server refuses it while the bot runs. */
  setComputer(botId: string, mode: ComputerMode): Promise<Bot>;
  /** Creates the routine in the device's timezone and adds it to the open bot's routines. */
  createRoutine(botId: string, payload: RoutinePayload): Promise<Routine>;
  /** Writes the patch, then merges the returned routine into the open bot's routines by id. */
  updateRoutine(botId: string, routineId: string, patch: RoutinePatch): Promise<Routine>;
  removeRoutine(botId: string, routineId: string): Promise<void>;
  testRun(botId: string, routineId: string): Promise<void>;
  /** The bot's webhook key, created on the first read; the roster learns the bot has one. */
  webhookSecret(botId: string): Promise<string>;
  /** Replaces the bot's webhook key and returns the new one; the old one stops working at once. */
  rotateWebhookSecret(botId: string): Promise<string>;
  /** The lifecycle actions the sidebar menu already runs, with the same confirmations. */
  botAction(botId: string, action: BotAction): void;
  /** Reads the bot and its routines again; rejects when either read fails. */
  refresh(botId: string): Promise<void>;
  /** Changes whenever a run of the open bot ends. */
  readonly activityEpoch: number;
  /** Opens the run's thread on the message that started it, closing the panel if it hides that thread. */
  openRun(row: Pick<RunActivityRow, "botId" | "groupId" | "sourceMessageId">): void;
  /** Re-reads the composer's skill catalog after a skill write the server has confirmed. */
  skillsChanged(): void;
}

export interface BotCommandDeps {
  setBots: Dispatch<SetStateAction<Bot[]>>;
  setRoutines: Dispatch<SetStateAction<Routine[]>>;
  setRoutinesBotId: Dispatch<SetStateAction<string | null>>;
  activeBotId: RefObject<string | undefined>;
  /**
   * Replaces a roster refresh already in flight, which would carry the bot as it
   * was before a write, with one started after it.
   */
  supersedeBotsRefresh: () => void;
  botAction: BotCommands["botAction"];
  refreshThread: (botId: string) => Promise<unknown>;
  navigate: (to: { pathname: string; search: string | undefined }) => void;
  /** True while the panel lies over the thread (narrow windows, or the wide panel below `xl`). */
  panelCoversThread: RefObject<boolean>;
  closePanel: () => void;
  activityEpoch: number;
  refreshSkills: () => void;
}

export function useBotCommands(deps: BotCommandDeps): BotCommands {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  // Per bot and per routine, what a late answer may still put back.
  const order = useRef(createAnswerOrder()).current;
  const { activityEpoch } = deps;

  return useMemo<BotCommands>(() => {
    async function writeBot(
      botId: string,
      sent: readonly string[],
      write: () => Promise<Bot>,
    ): Promise<Bot> {
      const request = order.next();
      const bot = await write();
      const merge = order.write(botId, request, sent, bot);
      if (merge) mergeIntoRoster(botId, merge);
      return bot;
    }

    function mergeIntoRoster(botId: string, merge: (bot: Bot) => Bot) {
      depsRef.current.supersedeBotsRefresh();
      depsRef.current.setBots((list) =>
        list.map((item) => (item.id === botId ? merge(item) : item)),
      );
    }

    /** Routines belong to the open bot only: an answer for another bot leaves them alone. */
    function setOpenBotRoutines(botId: string, update: (list: Routine[]) => Routine[]) {
      if (depsRef.current.activeBotId.current !== botId) return;
      depsRef.current.setRoutines((list) =>
        list.some((item) => item.botId !== botId) ? list : update(list),
      );
    }

    return {
      activityEpoch,
      updateBot: (botId, patch) =>
        writeBot(botId, Object.keys(patch), () => rpc.bots.update({ botId, ...patch })),
      setComputer: (botId, mode) =>
        writeBot(botId, ["computerMode"], () => rpc.bots.setComputer({ botId, mode })),
      async createRoutine(botId, payload) {
        const request = order.next();
        const routine = await rpc.routines.create({
          botId,
          timezone: localTimezone(),
          ...payload,
        });
        order.write(`routine:${routine.id}`, request, [], routine);
        setOpenBotRoutines(botId, (list) => [
          ...list.filter((item) => item.id !== routine.id),
          routine,
        ]);
        return routine;
      },
      async updateRoutine(botId, routineId, patch) {
        const request = order.next();
        const routine = await rpc.routines.update({ routineId, ...patch });
        const merge = order.write(`routine:${routineId}`, request, Object.keys(patch), routine);
        if (merge) {
          setOpenBotRoutines(botId, (list) =>
            list.map((item) => (item.id === routine.id ? merge(item) : item)),
          );
        }
        return routine;
      },
      async removeRoutine(botId, routineId) {
        await rpc.routines.remove({ routineId });
        order.close(`routine:${routineId}`);
        setOpenBotRoutines(botId, (list) => list.filter((item) => item.id !== routineId));
      },
      async testRun(botId, routineId) {
        await rpc.routines.testRun({ routineId });
        await depsRef.current.refreshThread(botId).catch(() => undefined);
      },
      async webhookSecret(botId) {
        const { secret } = await rpc.bots.webhookSecret({ botId });
        depsRef.current.setBots((list) =>
          list.map((bot) => (bot.id === botId ? { ...bot, webhookConfigured: true } : bot)),
        );
        return secret;
      },
      async rotateWebhookSecret(botId) {
        const { secret } = await rpc.bots.rotateWebhookSecret({ botId });
        if (secret === null) throw new Error("rotateWebhookSecret answered without a key");
        return secret;
      },
      botAction: (botId, action) => depsRef.current.botAction(botId, action),
      async refresh(botId) {
        const request = order.next();
        const [bot, routines] = await Promise.all([
          rpc.bots.get({ botId }),
          rpc.routines.list({ botId }),
        ]);
        if (order.read(botId, request)) mergeIntoRoster(botId, () => bot);
        if (depsRef.current.activeBotId.current !== botId) return;
        if (!order.read(`routines:${botId}`, request)) return;
        // Per routine, the read lands unless a write answered meanwhile: then what that write left
        // stays, a routine created during the read included and a removed one still gone.
        const fresh = (id: string) => order.read(`routine:${id}`, request);
        depsRef.current.setRoutines((list) => {
          const held = list.filter((item) => item.botId === botId);
          const read = new Set(routines.map((item) => item.id));
          return [
            ...routines.flatMap((item) =>
              fresh(item.id) ? [item] : held.filter((kept) => kept.id === item.id),
            ),
            ...held.filter((item) => !read.has(item.id) && !fresh(item.id)),
          ];
        });
        depsRef.current.setRoutinesBotId(botId);
      },
      openRun(row) {
        if (depsRef.current.panelCoversThread.current) depsRef.current.closePanel();
        depsRef.current.navigate(
          threadJumpLocation({
            botId: row.botId,
            groupId: row.groupId,
            messageId: row.sourceMessageId,
          }),
        );
      },
      skillsChanged: () => depsRef.current.refreshSkills(),
    };
  }, [order, activityEpoch]);
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
