import { useLingui } from "@lingui/react/macro";
import type { Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { Button, StackedAvatars } from "@rakazo/ui-web";
import { Menu, Mic, Monitor, PanelLeftOpen, Settings } from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { desktopBridge } from "../../lib/desktop";
import { WindowChrome } from "../WindowChrome";
import type { Panel } from "./layout";

export function ThreadHeader({
  botsSidebarCollapsed,
  setMobileSidebarOpen,
  setBotsSidebarCollapsedPref,
  inGroup,
  active,
  activeGroup,
  activeSnapshot,
  panel,
  setPanel,
  refreshThread,
  onVoice,
  voiceButtonRef,
  disabled,
}: {
  botsSidebarCollapsed: boolean;
  setMobileSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setBotsSidebarCollapsedPref: (collapsed: boolean) => void;
  inGroup: boolean;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  panel: Panel;
  setPanel: Dispatch<SetStateAction<Panel>>;
  refreshThread: (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>;
  /** 1:1 conversations only — a group has no call, only the composer's dictation. */
  onVoice?: () => void;
  voiceButtonRef?: RefObject<HTMLButtonElement | null>;
  /** Same readiness logic as the composer's own buttons (e.g. a skill is being taught). */
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const members = activeSnapshot?.members ?? activeGroup?.members ?? [];
  return (
    <div className="app-drag flex h-header shrink-0 items-center justify-between gap-2 px-3 md:px-5.5">
      <div className="flex min-w-0 items-center gap-2">
        {/* Collapsed bots sidebar: this header is the leading edge for window chrome. */}
        {botsSidebarCollapsed && desktopBridge() ? <WindowChrome /> : null}
        <Button
          variant="roundIcon"
          size="roundIconSm"
          aria-label={t`Open navigation`}
          onClick={() => setMobileSidebarOpen(true)}
          className="app-no-drag shrink-0 md:hidden"
        >
          <Menu size={19} strokeWidth={1.7} />
        </Button>
        {botsSidebarCollapsed ? (
          <Button
            variant="roundIcon"
            size="roundIconSm"
            data-testid="restore-bots-sidebar"
            aria-label={t`Show bots`}
            title={t`Show bots`}
            onClick={() => setBotsSidebarCollapsedPref(false)}
            className="app-no-drag hidden shrink-0 md:inline-flex"
          >
            <PanelLeftOpen size={19} strokeWidth={1.7} aria-hidden="true" />
          </Button>
        ) : null}
        <button
          type="button"
          data-testid="bot-settings-trigger"
          onClick={() => setPanel(inGroup ? "group-settings" : "settings")}
          className="app-no-drag -mx-2 flex min-w-0 items-center gap-3 rounded-lg px-2 py-1 transition-colors hover:bg-muted"
        >
          <span className="block min-w-0 truncate text-title text-foreground" dir="auto">
            {inGroup
              ? (activeGroup?.name ?? activeSnapshot?.groupName ?? t`Group`)
              : (active?.name ?? t`Select a bot`)}
          </span>
          {inGroup ? (
            <StackedAvatars
              size={20}
              className="shrink-0"
              label={members.map((member) => member.name).join(", ")}
              items={members.map((member) => ({
                color: member.color,
                identity: member.botId,
                shapeSeed: member.shapeSeed,
                working: ACTIVE_RUN_STATUSES.some((status) => status === member.status),
              }))}
            />
          ) : null}
        </button>
      </div>
      <div className="flex items-center gap-1">
        {!inGroup && active && onVoice ? (
          <Button
            ref={voiceButtonRef}
            variant="tertiary"
            size="capsule"
            data-testid="open-voice-call"
            aria-label={t`Voice`}
            title={t`Voice`}
            disabled={disabled}
            onClick={onVoice}
            className="app-no-drag"
          >
            <Mic size={17} strokeWidth={1.6} aria-hidden="true" />
          </Button>
        ) : null}
        {!inGroup && active ? (
          <>
            <Button
              variant="tertiary"
              size="capsule"
              data-testid="open-computer-panel"
              aria-label={t`Computer & routines`}
              title={t`Computer & routines`}
              onClick={() => {
                const next = panel === "computer" ? null : "computer";
                setPanel(next);
                if (next === "computer" && active) {
                  // Refresh run/computer so Take control isn't stuck on a stale busyBotName.
                  void refreshThread(active.id).catch(() => undefined);
                }
              }}
              aria-pressed={panel === "computer"}
              className="app-no-drag"
            >
              <Monitor size={17} strokeWidth={1.6} aria-hidden="true" />
            </Button>
            <Button
              variant="tertiary"
              size="capsule"
              data-testid="open-settings-panel"
              aria-label={t`Bot settings`}
              title={t`Bot settings`}
              onClick={() => setPanel(panel === "settings" ? null : "settings")}
              aria-pressed={panel === "settings"}
              className="app-no-drag"
            >
              <Settings size={17} strokeWidth={1.6} aria-hidden="true" />
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
