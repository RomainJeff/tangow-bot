import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  BotSection,
  Group,
  Me,
  SearchHit,
  Space,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  GroupAvatar,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import {
  Bell,
  ChevronDown,
  Gauge,
  Lock,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useRef } from "react";
import { authClient } from "../../lib/auth";
import { BOTS_SIDEBAR_EDGE_DRAG_PX } from "../../lib/bots-sidebar-pref";
import { desktopBridge } from "../../lib/desktop";
import { clearSpaceSelection, rpc } from "../../lib/rpc";
import { ActivityList, runStatusLabel } from "../ActivityList";
import type { ContextMenuPosition } from "../BotContextMenu";
import type { SettingsSection } from "../SettingsOverlay";
import { SpaceSearchResults } from "../SpaceSearch";
import { WindowChrome } from "../WindowChrome";
import { BotCreatePicker } from "./bot-picker";
import type { Panel, SidebarGroup } from "./layout";

export function BotsSidebar({
  botsSidebarCollapsed,
  mobileSidebarOpen,
  activityMode,
  toggleActivityMode,
  setBotsSidebarCollapsedPref,
  createMenuOpen,
  setCreateMenuOpen,
  bots,
  setMobileSidebarOpen,
  setPanel,
  navigate,
  setNewSpaceOpen,
  setPickerInfoTopic,
  query,
  setQuery,
  showSpaceSearch,
  searchHits,
  searchLoading,
  jumpToSearchHit,
  sidebarGroups,
  collapsedSidebarSections,
  openSpaceChat,
  toggleSidebarSection,
  spaceMenuAnchor,
  setSpaceMenu,
  sectionMenuAnchor,
  setSectionMenu,
  botSections,
  spaces,
  draggedBotId,
  setDraggedBotId,
  reorderRosterBot,
  bootstrapMe,
  botMenuAnchor,
  setBotMenu,
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  initials,
  userImage,
  archivedBots,
  archivedGroups,
  archivedOpen,
  setArchivedOpen,
  refreshBots,
  setDeleteTarget,
  onOpenArchivedBot,
  onRestoreBot,
  setDeleteGroupTarget,
  setCustomizeOpen,
  menuOpen,
  setMenuOpen,
  userName,
  setFailedUserImage,
  openSettings,
  setUsage,
  botsSidebarEdgeDragRef,
}: {
  botsSidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  activityMode: boolean;
  toggleActivityMode: () => void;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  createMenuOpen: boolean;
  setCreateMenuOpen: Dispatch<SetStateAction<boolean>>;
  bots: Bot[];
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setPanel: Dispatch<SetStateAction<Panel>>;
  navigate: (path: string) => void;
  setNewSpaceOpen: Dispatch<SetStateAction<boolean>>;
  setPickerInfoTopic: Dispatch<SetStateAction<"group" | "space" | null>>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  showSpaceSearch: boolean;
  searchHits: SearchHit[];
  searchLoading: boolean;
  jumpToSearchHit: (hit: SearchHit) => Promise<void>;
  sidebarGroups: SidebarGroup[];
  collapsedSidebarSections: Set<string>;
  openSpaceChat: (spaceId: string, path: string) => void;
  toggleSidebarSection: (key: string) => void;
  spaceMenuAnchor: RefObject<HTMLElement | null>;
  setSpaceMenu: Dispatch<SetStateAction<{ id: string; position: ContextMenuPosition } | null>>;
  sectionMenuAnchor: RefObject<HTMLElement | null>;
  setSectionMenu: Dispatch<
    SetStateAction<{
      section: BotSection;
      spaceId: string;
      position: ContextMenuPosition;
    } | null>
  >;
  botSections: BotSection[];
  spaces: Space[];
  draggedBotId: string | null;
  setDraggedBotId: Dispatch<SetStateAction<string | null>>;
  reorderRosterBot: (sourceId: string, targetId: string, groupBotIds: string[]) => void;
  bootstrapMe: Me | null | undefined;
  botMenuAnchor: RefObject<HTMLElement | null>;
  setBotMenu: Dispatch<
    SetStateAction<{ kind: "bot" | "group"; id: string; position: ContextMenuPosition } | null>
  >;
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: Pick<ThreadSnapshot, "groupId" | "groupName" | "members"> | null;
  initials: string;
  userImage: string | null;
  archivedBots: Bot[];
  archivedGroups: Group[];
  archivedOpen: boolean;
  setArchivedOpen: Dispatch<SetStateAction<boolean>>;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
  setDeleteTarget: Dispatch<SetStateAction<Bot | null>>;
  /** Opens an archived bot's page, read-only. */
  onOpenArchivedBot: (botId: string) => void;
  onRestoreBot: (botId: string) => void;
  setDeleteGroupTarget: Dispatch<SetStateAction<Group | null>>;
  setCustomizeOpen: Dispatch<SetStateAction<boolean>>;
  menuOpen: boolean;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  userName: string;
  setFailedUserImage: Dispatch<SetStateAction<string | null>>;
  openSettings: (section?: SettingsSection) => void;
  setUsage: Dispatch<
    SetStateAction<{ inputTokens: number; outputTokens: number; runs: number } | null>
  >;
  botsSidebarEdgeDragRef: RefObject<{ startX: number; mode: "expand" | "collapse" } | null>;
}) {
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
  const hasUnread = sidebarGroups.some((group) => group.bots.some((item) => item.chat.unread));
  return (
    <>
      <aside
        data-testid="bots-sidebar"
        data-collapsed={botsSidebarCollapsed ? "true" : "false"}
        inert={botsSidebarCollapsed && !mobileSidebarOpen ? true : undefined}
        className={`absolute inset-y-0 start-0 z-40 flex w-sidebar max-w-full shrink-0 flex-col bg-sidebar transition-[transform,width,opacity] md:static md:z-auto md:translate-x-0 ${
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full"
        } ${
          botsSidebarCollapsed
            ? "md:w-0 md:overflow-hidden md:opacity-0 md:pointer-events-none"
            : "md:w-sidebar"
        }`}
      >
        <div className="app-drag flex h-header shrink-0 items-center justify-between gap-2 px-4 ps-4.5">
          <div className="flex min-w-0 items-center gap-1">
            {desktopBridge() ? <WindowChrome /> : null}
            <Button
              variant="roundIcon"
              size="roundIconSm"
              className="app-no-drag hidden md:inline-flex"
              aria-label={t`Minimize bots`}
              title={t`Minimize bots`}
              data-testid="minimize-bots-sidebar"
              onClick={() => setBotsSidebarCollapsedPref(true)}
            >
              <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden="true" />
            </Button>
          </div>
          <div className="relative flex items-center gap-1">
            <Button
              variant="roundIcon"
              size="roundIconSm"
              className="app-no-drag relative"
              aria-label={t`Activity`}
              aria-pressed={activityMode}
              title={t`Activity`}
              data-activity-mode={activityMode ? "on" : "off"}
              onClick={toggleActivityMode}
            >
              <Bell size={16} strokeWidth={1.8} aria-hidden="true" />
              {hasUnread ? (
                <span
                  aria-hidden="true"
                  className="absolute end-1 top-1 size-1.25 rounded-full bg-foreground ring-2 ring-sidebar"
                />
              ) : null}
            </Button>
            <Popover open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
              <PopoverTrigger
                className="app-no-drag grid size-hover-icon place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                title={t`Create`}
                data-testid="create-menu-trigger"
              >
                <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
              </PopoverTrigger>
              {/* Unmount with the state change so the panel it opens never coexists with the menu. */}
              {createMenuOpen ? (
                <PopoverContent
                  align="end"
                  className="app-no-drag w-auto gap-0 overflow-hidden p-0 data-closed:animate-none"
                >
                  <BotCreatePicker
                    bots={bots}
                    onCreateBot={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setPanel("create");
                    }}
                    onOpenBot={(id) => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      navigate(`/app/${id}`);
                    }}
                    onCreateGroup={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setPanel("create-group");
                    }}
                    onCreateSpace={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setNewSpaceOpen(true);
                    }}
                    onShowGroupInfo={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setPickerInfoTopic("group");
                    }}
                    onShowSpaceInfo={() => {
                      setCreateMenuOpen(false);
                      setMobileSidebarOpen(false);
                      setPickerInfoTopic("space");
                    }}
                  />
                </PopoverContent>
              ) : null}
            </Popover>
          </div>
        </div>
        <InputGroup
          data-testid="sidebar-search"
          className="mx-2.5 mb-2 w-auto rounded-row bg-surface"
        >
          <InputGroupAddon>
            <Search size={16} strokeWidth={1.8} aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Escape clears the query and drops focus; the field stays in
              // place. Its own listener must not reach the panel's Escape.
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
              searchRef.current?.blur();
            }}
            placeholder={t`Search`}
            autoComplete="off"
            name="sidebar-search"
          />
        </InputGroup>
        <div className="rk-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2.5">
          {showSpaceSearch ? (
            <SpaceSearchResults
              hits={searchHits}
              loading={searchLoading}
              onSelect={(hit) => void jumpToSearchHit(hit)}
            />
          ) : (
            <>
              {activityMode ? (
                <ActivityList
                  onOpenRun={(run) => {
                    setMobileSidebarOpen(false);
                    if (run.groupId) navigate(`/app/g/${run.groupId}`);
                    else navigate(`/app/${run.botId}`);
                  }}
                />
              ) : null}
              {sidebarGroups.map((group) => {
                const collapsed = Boolean(group.title) && collapsedSidebarSections.has(group.key);
                const groupBotIds = group.bots.flatMap((item) =>
                  item.kind === "bot" ? [item.chat.id] : [],
                );
                return (
                  <div key={group.key} data-sidebar-group={group.key}>
                    {group.title ? (
                      <div className="flex items-center pt-2">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-row px-2.5 py-1.5 text-label text-muted-foreground hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                          onClick={() => {
                            if (group.emptySpaceId) {
                              openSpaceChat(group.emptySpaceId, "/onboarding");
                              return;
                            }
                            toggleSidebarSection(group.key);
                          }}
                          onContextMenu={
                            group.sectionId
                              ? (event) => {
                                  event.preventDefault();
                                  // Prefer section rename over delete-space when both apply;
                                  // the dedicated space-actions button still opens the space menu.
                                  const sections =
                                    group.spaceId === bootstrapMe?.spaceId
                                      ? botSections
                                      : (spaces.find((space) => space.id === group.spaceId)
                                          ?.botSections ?? []);
                                  const section = sections.find(
                                    (item) => item.id === group.sectionId,
                                  );
                                  if (!section) return;
                                  sectionMenuAnchor.current = event.currentTarget;
                                  setSectionMenu({
                                    section,
                                    spaceId: group.spaceId,
                                    position: { x: event.clientX, y: event.clientY },
                                  });
                                }
                              : group.canDeleteSpace
                                ? (event) => {
                                    event.preventDefault();
                                    spaceMenuAnchor.current = event.currentTarget;
                                    setSpaceMenu({
                                      id: group.spaceId,
                                      position: { x: event.clientX, y: event.clientY },
                                    });
                                  }
                                : undefined
                          }
                          aria-expanded={group.emptySpaceId ? undefined : !collapsed}
                          aria-label={
                            group.emptySpaceId
                              ? t`Open ${group.title}`
                              : collapsed
                                ? t`Expand ${group.title}`
                                : t`Collapse ${group.title}`
                          }
                        >
                          <span className="flex min-w-0 items-center gap-1.5 truncate">
                            {group.showLock ? (
                              <Lock size={11} strokeWidth={2} aria-hidden="true" />
                            ) : null}
                            <span className="truncate">{group.title}</span>
                          </span>
                          {group.emptySpaceId ? null : (
                            <ChevronDown
                              size={14}
                              strokeWidth={1.8}
                              className={
                                collapsed
                                  ? "-rotate-90 transition-transform"
                                  : "transition-transform"
                              }
                              aria-hidden="true"
                            />
                          )}
                        </button>
                        {group.canDeleteSpace ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t`Actions for ${group.spaceName}`}
                            onClick={(event) => {
                              const rect = event.currentTarget.getBoundingClientRect();
                              spaceMenuAnchor.current = event.currentTarget;
                              setSpaceMenu({
                                id: group.spaceId,
                                position: { x: rect.left, y: rect.bottom },
                              });
                            }}
                          >
                            <MoreHorizontal size={14} aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    {!collapsed &&
                      group.bots.map((item) => {
                        const selected =
                          (item.kind === "bot" && !inGroup && active?.id === item.chat.id) ||
                          (item.kind === "group" && inGroup && activeGroup?.id === item.chat.id);
                        const running =
                          item.kind === "bot" &&
                          ACTIVE_RUN_STATUSES.some((status) => status === item.chat.status);
                        return (
                          <button
                            key={`${item.kind}:${item.chat.id}`}
                            type="button"
                            draggable={item.kind === "bot"}
                            data-roster-bot-id={item.kind === "bot" ? item.chat.id : undefined}
                            aria-keyshortcuts={
                              item.kind === "bot" ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                            }
                            onDragStart={(event) => {
                              if (item.kind !== "bot") return;
                              setDraggedBotId(item.chat.id);
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("text/plain", item.chat.id);
                            }}
                            onDragOver={(event) => {
                              if (
                                item.kind === "bot" &&
                                draggedBotId &&
                                groupBotIds.includes(draggedBotId)
                              ) {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                              }
                            }}
                            onDrop={(event) => {
                              if (item.kind !== "bot" || !draggedBotId) return;
                              event.preventDefault();
                              reorderRosterBot(draggedBotId, item.chat.id, groupBotIds);
                              setDraggedBotId(null);
                            }}
                            onDragEnd={() => setDraggedBotId(null)}
                            onKeyDown={(event) => {
                              if (
                                item.kind !== "bot" ||
                                !event.altKey ||
                                (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                              )
                                return;
                              const index = groupBotIds.indexOf(item.chat.id);
                              const target =
                                groupBotIds[index + (event.key === "ArrowUp" ? -1 : 1)];
                              if (!target) return;
                              event.preventDefault();
                              reorderRosterBot(item.chat.id, target, groupBotIds);
                            }}
                            onClick={() => {
                              openSpaceChat(
                                item.chat.spaceId,
                                item.kind === "bot"
                                  ? `/app/${item.chat.id}`
                                  : `/app/g/${item.chat.id}`,
                              );
                            }}
                            onContextMenu={(event) => {
                              if (item.chat.spaceId !== bootstrapMe?.spaceId) return;
                              event.preventDefault();
                              botMenuAnchor.current = event.currentTarget;
                              setBotMenu({
                                kind: item.kind,
                                id: item.chat.id,
                                position: { x: event.clientX, y: event.clientY },
                              });
                            }}
                            className={`flex w-full items-center gap-2.75 rounded-row px-2.5 py-2.25 text-start ${
                              item.kind === "bot" ? "cursor-grab active:cursor-grabbing" : ""
                            } ${selected ? "bg-sidebar-accent shadow-row" : "hover:bg-sidebar-accent"}`}
                            style={{
                              opacity:
                                item.kind === "bot" && draggedBotId === item.chat.id ? 0.55 : 1,
                            }}
                          >
                            {item.kind === "bot" ? (
                              <BotAvatar
                                color={item.chat.color}
                                identity={item.chat.id}
                                shapeSeed={item.chat.shapeSeed}
                                size={28}
                                status={item.chat.status}
                              />
                            ) : (
                              <GroupAvatar
                                members={
                                  item.chat.id === activeSnapshot?.groupId
                                    ? (activeSnapshot.members ?? item.chat.members)
                                    : item.chat.members
                                }
                                size={28}
                                userInitials={initials}
                                userImage={userImage}
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  dir="auto"
                                  data-roster-bot-name={item.kind === "bot" ? "" : undefined}
                                  // The type token sets a weight that does not inherit,
                                  // so the selected bump belongs on the name itself.
                                  className={`truncate text-row-name text-foreground ${
                                    selected ? "font-medium" : ""
                                  }`}
                                >
                                  {item.chat.name}
                                  {item.chat.unread ? (
                                    <span className="sr-only">
                                      <Trans> (unread)</Trans>
                                    </span>
                                  ) : null}
                                </span>
                                {item.chat.unread ? (
                                  <span
                                    aria-hidden="true"
                                    className="size-1.25 shrink-0 rounded-full bg-foreground"
                                  />
                                ) : null}
                              </div>
                              <div
                                dir="auto"
                                className="truncate text-row-status text-foreground-subtle"
                              >
                                {running
                                  ? runStatusLabel(item.chat.status)
                                  : item.kind === "bot"
                                    ? item.chat.title || item.chat.preview
                                    : item.chat.preview ||
                                      item.chat.members.map((member) => member.name).join(", ")}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                  </div>
                );
              })}
            </>
          )}
          {archivedBots.length + archivedGroups.length > 0 && !showSpaceSearch ? (
            <div className="mt-2 border-t border-border pt-2">
              <button
                type="button"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((open) => !open)}
                className="flex w-full items-center justify-between rounded-row px-2.5 py-2 text-reasoning text-muted-foreground hover:bg-sidebar-accent"
              >
                <span>
                  <Trans>Archived</Trans>
                </span>
                <span>{archivedBots.length + archivedGroups.length}</span>
              </button>
              {archivedOpen ? (
                <>
                  {archivedBots.map((bot) => (
                    <div key={bot.id} className="flex items-center gap-2 rounded-row px-2.5 py-2">
                      <button
                        type="button"
                        data-testid="archived-bot-open"
                        onClick={() => {
                          setMobileSidebarOpen(false);
                          onOpenArchivedBot(bot.id);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-chip text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <BotAvatar
                          color={bot.color}
                          identity={bot.id}
                          shapeSeed={bot.shapeSeed}
                          size={28}
                          status={bot.status}
                        />
                        <span
                          className="min-w-0 flex-1 truncate text-capsule text-foreground/75 hover:text-foreground"
                          dir="auto"
                        >
                          {bot.name}
                        </span>
                      </button>
                      <Button variant="ghost" size="xs" onClick={() => onRestoreBot(bot.id)}>
                        <Trans>Restore</Trans>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        aria-label={t`Delete ${bot.name}`}
                        onClick={() => setDeleteTarget(bot)}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </div>
                  ))}
                  {archivedGroups.map((group) => (
                    <div key={group.id} className="flex items-center gap-2 rounded-row px-2.5 py-2">
                      <GroupAvatar
                        members={group.members}
                        size={28}
                        userInitials={initials}
                        userImage={userImage}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-capsule text-foreground/75"
                        dir="auto"
                      >
                        {group.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          void rpc.groups
                            .restore({ groupId: group.id })
                            .then(() => refreshBots(true))
                        }
                      >
                        <Trans>Restore</Trans>
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-destructive hover:text-destructive"
                        aria-label={t`Delete ${group.name}`}
                        onClick={() => setDeleteGroupTarget(group)}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-0.5 px-2.5 pb-2.5">
          <button
            type="button"
            data-testid="open-customize"
            onClick={() => setCustomizeOpen(true)}
            className="flex min-w-0 items-center gap-2.75 rounded-row px-2.5 py-2.25 hover:bg-sidebar-accent"
          >
            <SlidersHorizontal
              size={16}
              strokeWidth={1.7}
              aria-hidden="true"
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-meta text-foreground">
              <Trans>Customize</Trans>
            </span>
          </button>
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger
              data-testid="user-menu-trigger"
              className="flex min-w-0 items-center gap-2.75 rounded-row px-2.5 py-2.25 hover:bg-sidebar-accent"
            >
              {userImage ? (
                <img
                  src={userImage}
                  alt=""
                  className="size-6 shrink-0 rounded-full object-cover"
                  onError={() => setFailedUserImage(userImage)}
                />
              ) : (
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-label font-medium text-muted-foreground">
                  {initials}
                </span>
              )}
              <span className="truncate text-meta text-foreground">{userName}</span>
            </PopoverTrigger>
            {menuOpen ? (
              <PopoverContent
                side="top"
                align="start"
                className="w-56 gap-0 p-1 data-closed:animate-none"
              >
                <Button
                  variant="ghost"
                  className="w-full justify-start font-normal"
                  aria-label={t`Settings`}
                  onClick={() => {
                    setMenuOpen(false);
                    openSettings("general");
                  }}
                >
                  <Settings className="text-muted-foreground" strokeWidth={1.75} />
                  <Trans>Settings</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start font-normal"
                  aria-label={t`Usage`}
                  onClick={() => {
                    setMenuOpen(false);
                    void rpc.usage
                      .summary()
                      .then(setUsage)
                      .catch(() => undefined);
                    openSettings("usage");
                  }}
                >
                  <Gauge className="text-muted-foreground" strokeWidth={1.75} />
                  <Trans>Usage</Trans>
                </Button>
                <Button
                  variant="ghost"
                  className="w-full justify-start font-normal"
                  onClick={() =>
                    void authClient.signOut().then(() => {
                      clearSpaceSelection();
                      navigate("/");
                    })
                  }
                >
                  <LogOut className="text-muted-foreground" strokeWidth={1.75} />
                  <Trans>Log out</Trans>
                </Button>
              </PopoverContent>
            ) : null}
          </Popover>
        </div>
      </aside>

      <button
        type="button"
        data-testid="bots-sidebar-edge"
        aria-label={botsSidebarCollapsed ? t`Show bots` : t`Hide bots`}
        aria-pressed={!botsSidebarCollapsed}
        className={`absolute inset-y-0 z-50 hidden w-2 cursor-ew-resize touch-none border-0 bg-transparent p-0 md:block ${
          botsSidebarCollapsed ? "start-0" : "-ms-2 start-sidebar"
        }`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          botsSidebarEdgeDragRef.current = {
            startX: event.clientX,
            mode: botsSidebarCollapsed ? "expand" : "collapse",
          };
        }}
        onPointerMove={(event) => {
          const drag = botsSidebarEdgeDragRef.current;
          if (!drag) return;
          const rtl =
            typeof document !== "undefined" &&
            document.documentElement.getAttribute("dir") === "rtl";
          const delta = rtl ? drag.startX - event.clientX : event.clientX - drag.startX;
          if (drag.mode === "expand" && delta >= BOTS_SIDEBAR_EDGE_DRAG_PX) {
            botsSidebarEdgeDragRef.current = null;
            setBotsSidebarCollapsedPref(false);
          } else if (drag.mode === "collapse" && delta <= -BOTS_SIDEBAR_EDGE_DRAG_PX) {
            botsSidebarEdgeDragRef.current = null;
            setBotsSidebarCollapsedPref(true);
          }
        }}
        onPointerUp={(event) => {
          const drag = botsSidebarEdgeDragRef.current;
          botsSidebarEdgeDragRef.current = null;
          if (!drag) return;
          if (Math.abs(event.clientX - drag.startX) < BOTS_SIDEBAR_EDGE_DRAG_PX) {
            setBotsSidebarCollapsedPref(!botsSidebarCollapsed);
          }
        }}
        onPointerCancel={() => {
          botsSidebarEdgeDragRef.current = null;
        }}
      />
    </>
  );
}
