import type { Bot, Group, SpaceBot, SpaceGroup, ThreadSnapshot } from "@rakazo/contracts";

export type Panel =
  | "computer"
  | "bot"
  | "routine"
  | "create"
  | "create-group"
  | "group-settings"
  | null;

export type BotTab = "routines" | "knowledge" | "settings";

/** What the bot page shows over its tab: an editor reached from a row. */
export type BotDetail =
  | { kind: "instructions" }
  | { kind: "description" }
  | { kind: "model" }
  | { kind: "voice" };

export type BotPageView = { tab: BotTab; detail: BotDetail | null };

export type PanelSize = "default" | "wide";

/** The panel widens to edit a long text; its width is never stored. */
export function panelSizeFor(panel: Panel, view: BotPageView): PanelSize {
  const kind = panel === "bot" ? view.detail?.kind : undefined;
  return kind === "instructions" || kind === "description" ? "wide" : "default";
}

/**
 * Whether the bot has never run, read from its conversation: no run under way and no message a
 * run wrote. A message seeded without a run (the onboarding question) does not count. Older
 * history that is not loaded may hold a run, so it counts as having run.
 */
export function neverRan(snapshot: Pick<ThreadSnapshot, "messages" | "olderCursor" | "run">) {
  return (
    !snapshot.run &&
    snapshot.olderCursor === null &&
    snapshot.messages.every((message) => !message.runId)
  );
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
