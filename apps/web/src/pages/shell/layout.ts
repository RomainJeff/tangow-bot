import type { Bot, Group, SpaceBot, SpaceGroup } from "@rakazo/contracts";

export type Panel = "computer" | "bot" | "create" | "create-group" | "group-settings" | null;

export type BotTab = "activity" | "routines" | "knowledge" | "settings";

/** What a new routine starts from, when something other than the empty form opens it. */
export type RoutineSeed = { name: string; prompt: string };

/** What the bot page shows over its tab: an editor reached from a row. */
export type BotDetail =
  | { kind: "instructions" }
  | { kind: "description" }
  | { kind: "model" }
  | { kind: "voice" }
  | { kind: "routine"; routineId: string }
  | { kind: "routine-new"; seed?: RoutineSeed }
  /** `skillId` null writes a new skill. */
  | { kind: "skill"; skillId: string | null };

export type BotPageView = { tab: BotTab; detail: BotDetail | null };

export type PanelSize = "default" | "wide";

const WIDE_DETAILS: ReadonlySet<BotDetail["kind"]> = new Set([
  "instructions",
  "description",
  "routine",
  "routine-new",
  "skill",
]);

/** The panel widens to edit a long text, a routine or a skill; its width is never stored. */
export function panelSizeFor(panel: Panel, view: BotPageView): PanelSize {
  return panel === "bot" && view.detail && WIDE_DETAILS.has(view.detail.kind) ? "wide" : "default";
}

export type BotPageEntry = "header" | "gear" | "menu" | "slash";

/**
 * Where each way into the bot page lands. The settings entries land on Activity while the bot has
 * no instructions, where the link to write them is.
 */
export function botPageFor(entry: BotPageEntry, bot?: Pick<Bot, "instructions">): BotPageView {
  if (entry === "header") return { tab: "activity", detail: null };
  return { tab: bot && !bot.instructions ? "activity" : "settings", detail: null };
}

/** The thread route that lands on one message: sidebar search hits and run rows share it. */
export function threadJumpLocation(target: {
  botId?: string | null;
  groupId?: string | null;
  messageId?: string | null;
  routineId?: string | null;
}): { pathname: string; search: string | undefined } {
  const params = new URLSearchParams();
  if (target.messageId) params.set("m", target.messageId);
  if (target.routineId) params.set("routine", target.routineId);
  const search = params.toString();
  return {
    pathname: target.groupId ? `/app/g/${target.groupId}` : `/app/${target.botId}`,
    search: search ? `?${search}` : undefined,
  };
}

/** The row that opened a detail carries this in `data-opens`, so focus can go back to it. */
export function detailOpener(detail: BotDetail): string {
  switch (detail.kind) {
    case "routine":
      return `routine:${detail.routineId}`;
    case "skill":
      return `skill:${detail.skillId ?? "new"}`;
    default:
      return detail.kind;
  }
}

export type PendingAttachment = {
  id: string;
  threadKey: string;
  file: File;
  previewUrl?: string;
};

/** The panel is showing when a kind is picked and it has something to show. */
export function panelIsOpen(
  panel: Panel,
  active: Bot | undefined,
  activeGroup: Group | undefined,
): boolean {
  return Boolean(panel && (active || activeGroup || panel === "create"));
}

/** Identity colour for bots the roster no longer knows about. */
export const FALLBACK_BOT_COLOR = "#85858A";

export function firstThreadRoute(
  bots: readonly Pick<Bot, "id">[],
  groups: readonly Pick<Group, "id">[],
): string {
  if (bots[0]) return `/app/${bots[0].id}`;
  if (groups[0]) return `/app/g/${groups[0].id}`;
  return "/app";
}

/** One roster row: a bot or a group, carrying the fields the sidebar sections key on. */
export type SidebarChat =
  | { kind: "bot"; chat: SpaceBot; pinned: boolean; sectionId: string | null }
  | { kind: "group"; chat: SpaceGroup; pinned: boolean; sectionId: string | null };

/** One rendered sidebar section, already resolved against its space. */
export type SidebarGroup = {
  key: string;
  title: string | null;
  bots: SidebarChat[];
  /** The bot section this group renders, when the group is a section rather than a space. */
  sectionId: string | null;
  showLock: boolean;
  emptySpaceId: string | undefined;
  spaceId: string;
  spaceName: string;
  canDeleteSpace: boolean;
};
