import type { SpaceBot } from "@tangow/contracts";
import type { MobileBot } from "./api";
import type { ComputerStatus } from "./computer";
import { t } from "./i18n";
import type { MenuAction } from "./native-menu";

/**
 * A bot someone else shared with you: you have your own thread with it, while its page, settings,
 * computer and routines stay its owner's. Unknown (still loading) counts as yours, the screens
 * behind it then answering not found.
 */
export function sharedWithMe(bot: MobileBot | SpaceBot | undefined): boolean {
  return bot !== undefined && "isOwner" in bot && bot.isOwner === false;
}

/** A shared bot's roster row carries no notification setting of yours: it never reads as muted. */
export function rosterMuted(bot: MobileBot | SpaceBot): boolean {
  return !sharedWithMe(bot) && !bot.notifyOnFinish;
}

export type ThreadBotHandlers = {
  openSettings: () => void;
  share: () => void;
  openComputer: () => void;
  clear: () => void;
  archive: () => void;
  remove: () => void;
};

/** The thread title's menu: the whole bot for its owner, only your own conversation otherwise. */
export function threadBotActions(shared: boolean, on: ThreadBotHandlers): MenuAction[] {
  const clear = { label: t("Clear conversation"), destructive: true, onPress: on.clear };
  if (shared) return [clear];
  return [
    { label: t("Bot settings"), onPress: on.openSettings },
    { label: t("Share"), onPress: on.share },
    { label: t("Open computer"), onPress: on.openComputer },
    clear,
    { label: t("Archive"), onPress: on.archive },
    { label: t("Delete…"), destructive: true, onPress: on.remove },
  ];
}

/**
 * What the computer screen offers. On a bot shared with you, only the takeover your own run asks
 * for: the computer itself, its mode and its upkeep, stays its owner's.
 */
export function computerScreenControls(
  shared: boolean,
  computer: Pick<ComputerStatus, "busyBotName" | "takeoverRequested"> | null,
) {
  return {
    takeControl: !computer?.busyBotName && (!shared || Boolean(computer?.takeoverRequested)),
    modePicker: !shared,
  };
}
