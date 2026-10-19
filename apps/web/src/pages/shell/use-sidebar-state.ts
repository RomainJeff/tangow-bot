import type { SearchHit } from "@rakazo/contracts";
import { groupBotsForSidebar } from "@rakazo/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { readActivityMode, writeActivityMode } from "../../lib/activity-mode";
import { readBotsSidebarCollapsed, writeBotsSidebarCollapsed } from "../../lib/bots-sidebar-pref";
import { rpc, selectedSpaceId, selectSpace } from "../../lib/rpc";
import { threadJumpLocation } from "./layout";
import type { Roster } from "./use-roster";

function collapsedSidebarSectionsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-sidebar-sections:${userId}`;
}

function readCollapsedSidebarSections(userId: string | null | undefined): Set<string> {
  const storageKey = collapsedSidebarSectionsStorageKey(userId);
  if (!storageKey) return new Set();
  try {
    const value = window.localStorage.getItem(storageKey);
    const keys: unknown = value ? JSON.parse(value) : [];
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * The sidebar's own state: its sections across spaces, which are collapsed,
 * whether it is hidden, the activity list toggle, and the space search.
 */
export function useSidebarState({
  userId,
  roster,
  navigate,
}: {
  userId: string | undefined;
  roster: Roster;
  navigate: NavigateFunction;
}) {
  const { bootstrapMe, botSections, bots, groups, spaces } = roster;
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());
  const [botsSidebarCollapsed, setBotsSidebarCollapsed] = useState(false);
  const botsSidebarEdgeDragRef = useRef<{ startX: number; mode: "expand" | "collapse" } | null>(
    null,
  );
  const [draggedBotId, setDraggedBotId] = useState<string | null>(null);

  useEffect(() => {
    setCollapsedSidebarSections(readCollapsedSidebarSections(userId));
  }, [userId]);
  useEffect(() => {
    setBotsSidebarCollapsed(readBotsSidebarCollapsed(userId));
  }, [userId]);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [activityMode, setActivityMode] = useState(readActivityMode);
  const toggleActivityMode = useCallback(() => {
    setActivityMode((on) => {
      const next = !on;
      writeActivityMode(next);
      return next;
    });
  }, []);

  const sidebarGroups = useMemo(() => {
    const needle = query.toLowerCase();
    const sidebarSpaces =
      spaces.length > 0
        ? spaces.map((space) =>
            space.id === bootstrapMe?.spaceId ? { ...space, bots, groups, botSections } : space,
          )
        : bootstrapMe
          ? [
              {
                id: bootstrapMe.spaceId,
                name: "Personal",
                isDefault: true,
                hasContent: true,
                canDelete: false,
                bots,
                groups,
                botSections,
              },
            ]
          : [];
    const showSpaceNames = sidebarSpaces.length > 1;
    return sidebarSpaces.flatMap((space) => {
      const visibleBots = space.bots.filter((bot) =>
        `${bot.name} ${bot.title ?? ""} ${bot.preview ?? ""}`.toLowerCase().includes(needle),
      );
      const visibleGroups = space.groups.filter((group) =>
        `${group.name} ${group.preview}`.toLowerCase().includes(needle),
      );
      const sections = groupBotsForSidebar(
        [
          ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
          ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
        ].map((item) => ({ ...item, pinned: item.chat.pinned, sectionId: item.chat.sectionId })),
        space.botSections,
      ).map((group, index) => ({
        ...group,
        sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
        key: showSpaceNames ? `space:${space.id}:${group.key}` : group.key,
        title: showSpaceNames
          ? group.title
            ? `${space.name} · ${group.title}`
            : space.name
          : group.title,
        showLock: showSpaceNames,
        emptySpaceId: undefined as string | undefined,
        spaceId: space.id,
        spaceName: space.name,
        canDeleteSpace: index === 0 && space.canDelete === true,
      }));
      if (sections.length > 0) return sections;
      // Keep empty spaces selectable; chat clicks are the only switch control.
      if (!showSpaceNames) return [];
      if (needle && (space.bots.length > 0 || space.groups.length > 0)) return [];
      return [
        {
          key: `space:${space.id}:empty`,
          title: space.name,
          bots: [],
          sectionId: null,
          showLock: true,
          emptySpaceId: space.id,
          spaceId: space.id,
          spaceName: space.name,
          canDeleteSpace: space.canDelete === true,
        },
      ];
    });
  }, [bootstrapMe, botSections, bots, groups, spaces, query]);

  const openSpaceChat = useCallback(
    (spaceId: string, path: string) => {
      const previousSpaceId = selectedSpaceId();
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      const selectionStored = selectSpace(spaceId);
      if (!selectionStored) return;
      const previousEffective = previousSpaceId ?? bootstrapMe?.spaceId;
      const boundaryChanged = previousEffective !== spaceId;
      // Soft-navigate within the same space; reload only when the auth boundary changes
      // so bootstrapped bots/groups match the request header.
      if (boundaryChanged) {
        window.location.assign(path);
        return;
      }
      // Opened from the list: the chat's Back returns to it by popping this entry.
      navigate(path, { state: { fromList: true } });
    },
    [bootstrapMe?.spaceId, navigate],
  );
  const toggleSidebarSection = useCallback(
    (key: string) => {
      setCollapsedSidebarSections((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        const storageKey = collapsedSidebarSectionsStorageKey(userId);
        if (storageKey) {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify([...next]));
          } catch {
            // Keep the UI usable when storage is unavailable.
          }
        }
        return next;
      });
    },
    [userId],
  );
  const spaceQuery = query.trim();
  const showSpaceSearch = spaceQuery.length > 0;

  useEffect(() => {
    if (!showSpaceSearch) {
      setSearchHits([]);
      setSearchLoading(false);
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void rpc.search
        .query({ q: spaceQuery })
        .then((result) => {
          if (!abort.signal.aborted) setSearchHits(result.hits);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchHits([]);
        })
        .finally(() => {
          if (!abort.signal.aborted) setSearchLoading(false);
        });
    }, 200);
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [showSpaceSearch, spaceQuery]);

  async function jumpToSearchHit(hit: SearchHit) {
    setQuery("");
    setSearchHits([]);
    navigate(threadJumpLocation(hit));
  }

  function setBotsSidebarCollapsedPref(collapsed: boolean) {
    setBotsSidebarCollapsed(collapsed);
    writeBotsSidebarCollapsed(userId, collapsed);
  }

  return {
    archivedOpen,
    setArchivedOpen,
    collapsedSidebarSections,
    toggleSidebarSection,
    botsSidebarCollapsed,
    setBotsSidebarCollapsedPref,
    botsSidebarEdgeDragRef,
    draggedBotId,
    setDraggedBotId,
    activityMode,
    toggleActivityMode,
    query,
    setQuery,
    showSpaceSearch,
    searchHits,
    searchLoading,
    jumpToSearchHit,
    sidebarGroups,
    openSpaceChat,
  };
}
