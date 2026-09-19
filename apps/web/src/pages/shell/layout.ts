import type { Bot, Group, SpaceBot, SpaceGroup } from "@rakazo/contracts";

export type Panel =
  | "computer"
  | "settings"
  | "routine"
  | "create"
  | "create-group"
  | "group-settings"
  | null;

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
