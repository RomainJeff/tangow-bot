import { useLingui } from "@lingui/react/macro";
import type { SearchHit } from "@rakazo/contracts";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@rakazo/ui-web";
import { Search } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useRef } from "react";
import { BOTS_SIDEBAR_EDGE_DRAG_PX } from "../../lib/bots-sidebar-pref";
import { ActivityList } from "../ActivityList";
import { SpaceSearchResults } from "../SpaceSearch";
import type { SidebarArchivedProps, SidebarFooterProps } from "./sidebar-footer";
import { SidebarArchived, SidebarFooter } from "./sidebar-footer";
import type { SidebarHeaderProps } from "./sidebar-header";
import { SidebarHeader } from "./sidebar-header";
import type { SidebarRosterProps } from "./sidebar-roster";
import { SidebarRoster } from "./sidebar-roster";

type BotsSidebarProps = SidebarHeaderProps &
  SidebarRosterProps &
  SidebarArchivedProps &
  SidebarFooterProps & {
    botsSidebarCollapsed: boolean;
    mobileSidebarOpen: boolean;
    query: string;
    setQuery: Dispatch<SetStateAction<string>>;
    showSpaceSearch: boolean;
    searchHits: SearchHit[];
    searchLoading: boolean;
    jumpToSearchHit: (hit: SearchHit) => Promise<void>;
    botsSidebarEdgeDragRef: RefObject<{ startX: number; mode: "expand" | "collapse" } | null>;
  };

export function BotsSidebar(props: BotsSidebarProps) {
  const {
    botsSidebarCollapsed,
    mobileSidebarOpen,
    activityMode,
    setBotsSidebarCollapsedPref,
    setMobileSidebarOpen,
    navigate,
    query,
    setQuery,
    showSpaceSearch,
    searchHits,
    searchLoading,
    jumpToSearchHit,
    botsSidebarEdgeDragRef,
  } = props;
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
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
        <SidebarHeader {...props} />
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
              <SidebarRoster {...props} />
            </>
          )}
          {showSpaceSearch ? null : <SidebarArchived {...props} />}
        </div>
        <SidebarFooter {...props} />
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
