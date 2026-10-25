import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ComputerMode,
  ComputerReleaseReason,
  ComputerStatus,
  Group,
  Routine,
  SpaceMemoryConfig,
  TaughtSkill,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback } from "react";
import { ComputerMaintenanceActions } from "../../components/ComputerMaintenanceActions";
import { TeachCaptureOverlay } from "../../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../../components/teach/TeachComputerOverlay";
import { TeachRecordingChrome, TeachStopButton } from "../../components/teach/TeachRecordingChrome";
import { desktopBridge } from "../../lib/desktop";
import { rpc } from "../../lib/rpc";
import { BotPage } from "../bot-page/BotPage";
import { CreateGroupForm, GroupSettings } from "../GroupPanel";
import { WindowChrome } from "../WindowChrome";
import type { BotCommands } from "./bot-commands";
import { CreateBotForm } from "./bot-panel";
import { ComputerPreview, computerLabel } from "./computer-preview";
import type { BotPageView, Panel, PanelSize } from "./layout";
import { firstThreadRoute, panelIsOpen } from "./layout";
import { usePanelEscape } from "./panel-escape";
import type { ScreenLinkHandlers } from "./screen-frame";
import { ScreenFrame } from "./screen-frame";

export function SidePanel({
  panel,
  setPanel,
  size,
  botPage,
  onBotPage,
  commands,
  userId,
  pageBot,
  active,
  activeGroup,
  computer,
  computerOpen,
  escapeCloses,
  booting,
  embeddedScreenUrl,
  computerScreenError,
  screenLink,
  openComputer,
  refreshGroupThread,
  refreshBots,
  activeRoutines,
  messagingProviders,
  memoryProviderConfig,
  bots,
  groups,
  setGroups,
  navigate,
  createGroup,
  createBot,
}: {
  panel: Panel;
  setPanel: Dispatch<SetStateAction<Panel>>;
  size: PanelSize;
  botPage: BotPageView;
  /** Moves the open bot page to this view. */
  onBotPage: (view: BotPageView) => void;
  commands: BotCommands;
  userId: string;
  /** The bot the bot page shows: the thread's, or an archived one opened from the sidebar. */
  pageBot: Bot | undefined;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  /** False while a full-screen overlay or a call owns the Escape key. */
  escapeCloses: boolean;
  booting: boolean;
  embeddedScreenUrl: string | null;
  computerScreenError: ReactNode;
  screenLink: ScreenLinkHandlers;
  openComputer: () => Promise<void>;
  refreshGroupThread: (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
  /** `null` until the open bot's routines are read. */
  activeRoutines: Routine[] | null;
  messagingProviders: string[];
  memoryProviderConfig: SpaceMemoryConfig | null | undefined;
  bots: Bot[];
  groups: Group[];
  setGroups: Dispatch<SetStateAction<Group[]>>;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  createGroup: (input: { name: string; description: string; botIds: string[] }) => Promise<void>;
  createBot: (input: {
    name: string;
    title: string;
    description: string;
    computerMode: ComputerMode;
  }) => Promise<void>;
}) {
  const { t } = useLingui();
  const open = panelIsOpen(panel, panel === "bot" ? pageBot : active, activeGroup);
  const closeEditor = useCallback(
    () => onBotPage({ tab: botPage.tab, detail: null }),
    [onBotPage, botPage.tab],
  );
  const closePanel = useCallback(() => setPanel(null), [setPanel]);
  usePanelEscape({
    enabled: open && escapeCloses,
    editorOpen: panel === "bot" && botPage.detail !== null,
    closeEditor,
    closePanel,
  });
  return (
    <aside
      data-testid="side-panel"
      data-panel={panel ?? "closed"}
      data-detail={panel === "bot" ? botPage.detail?.kind : undefined}
      data-size={size}
      // At phone and tablet width the panel takes the whole column on the page background,
      // which Safari paints its bars in; beside the thread it floats as a sheet, like the sidebar.
      className={`absolute inset-y-0 end-0 z-30 flex min-h-0 shrink-0 flex-col ${
        open
          ? `w-full bg-background lg:bg-transparent lg:p-2 ${size === "wide" ? "lg:w-panel-wide" : "lg:w-panel"}`
          : "pointer-events-none w-0 overflow-hidden"
      }`}
    >
      {open ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:rounded-pane lg:bg-sheet lg:shadow-sheet">
          {panel === "bot" && pageBot ? (
            <BotPage
              key={pageBot.id}
              bot={pageBot}
              userId={userId}
              routines={pageBot.id === active?.id ? activeRoutines : null}
              memoryProviderConfigured={memoryProviderConfig != null}
              view={botPage}
              onView={onBotPage}
              onClose={() => setPanel(null)}
              commands={commands}
              messagingProviders={messagingProviders}
            />
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-end px-5 pt-4 pb-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Close panel`}
                    onClick={() => setPanel(null)}
                  >
                    <X size={16} strokeWidth={1.8} />
                  </Button>
                </div>
              </div>
              <div className="rk-scroll min-h-0 w-full flex-1 overflow-y-auto px-5 pb-4">
                {panel === "computer" && active ? (
                  <ComputerPreview
                    bot={active}
                    computer={computer}
                    computerOpen={computerOpen}
                    booting={booting}
                    embeddedScreenUrl={embeddedScreenUrl}
                    computerScreenError={computerScreenError}
                    screenLink={screenLink}
                    openComputer={openComputer}
                  />
                ) : null}
                {panel === "create-group" ? (
                  <CreateGroupForm
                    bots={bots}
                    onCancel={() => setPanel(null)}
                    onCreate={(input) => createGroup(input)}
                  />
                ) : null}
                {panel === "group-settings" && activeGroup ? (
                  <GroupSettings
                    key={activeGroup.id}
                    group={activeGroup}
                    bots={bots}
                    onSave={async (input) => {
                      const updated = await rpc.groups.update({
                        groupId: activeGroup.id,
                        ...input,
                      });
                      setGroups((current) =>
                        current.map((group) => (group.id === updated.id ? updated : group)),
                      );
                      setPanel(null);
                      await Promise.all([refreshBots(), refreshGroupThread(activeGroup.id)]).catch(
                        () => undefined,
                      );
                    }}
                    onRemove={async () => {
                      await rpc.groups.remove({ groupId: activeGroup.id });
                      const remainingGroups = groups.filter((group) => group.id !== activeGroup.id);
                      setGroups(remainingGroups);
                      setPanel(null);
                      navigate(firstThreadRoute(bots, remainingGroups), { replace: true });
                      await refreshBots().catch(() => undefined);
                    }}
                  />
                ) : null}
                {panel === "create" ? (
                  <CreateBotForm
                    onCancel={() => setPanel(null)}
                    onCreate={(input) => createBot(input)}
                  />
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}

export function ComputerOverlay({
  booting,
  active,
  computer,
  computerOpen,
  setComputerOpen,
  computerViewport,
  embeddedScreenUrl,
  computerScreenError,
  screenLink,
  hasControl,
  recordingSkill,
  teachBusy,
  stopTeaching,
  refreshActiveTeaching,
  composerRunning,
  sending,
  stopRun,
  releaseComputer,
  refreshThread,
  sendError,
}: {
  booting: boolean;
  active: Bot | undefined;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  setComputerOpen: Dispatch<SetStateAction<boolean>>;
  computerViewport: { height: number; offsetTop: number } | null;
  embeddedScreenUrl: string | null;
  computerScreenError: ReactNode;
  screenLink: ScreenLinkHandlers;
  hasControl: boolean;
  recordingSkill: TaughtSkill | null;
  teachBusy: boolean;
  stopTeaching: () => Promise<void>;
  refreshActiveTeaching: () => Promise<void>;
  composerRunning: boolean;
  sending: boolean;
  stopRun: () => Promise<void>;
  releaseComputer: (reason?: ComputerReleaseReason) => Promise<void>;
  refreshThread: (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>;
  sendError: string | null;
}) {
  const { t } = useLingui();
  return booting ? (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-[22px] bg-background/95">
      <div className="text-title font-medium text-foreground">
        <Trans>Booting up {active?.name}’s computer</Trans>
      </div>
      <div className="h-[5px] w-[min(420px,70%)] overflow-hidden rounded-full bg-accent">
        <div className="h-full w-2/3 rounded-full bg-primary" />
      </div>
    </div>
  ) : computerOpen && active ? (
    <div className="fixed inset-0 z-30 bg-background">
      <div
        data-testid="computer-viewport"
        className="fixed inset-x-0 top-0 flex flex-col bg-background"
        style={{
          height: computerViewport ? `${computerViewport.height}px` : "100dvh",
          top: computerViewport ? `${computerViewport.offsetTop}px` : undefined,
        }}
      >
        <div
          data-testid="computer-chrome"
          className="app-drag flex items-center justify-between gap-4 border-b border-sidebar-border px-4.5 py-3.5"
        >
          <div className="app-no-drag flex min-w-0 flex-1 items-center gap-3">
            {/* The overlay covers the shell header, so it reserves room for the window controls itself. */}
            {desktopBridge() ? <WindowChrome /> : null}
            <BotAvatar
              color={active.color}
              identity={active.id}
              shapeSeed={active.shapeSeed}
              size={28}
              status={active.status}
            />
            <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
              {recordingSkill ? (
                <TeachRecordingChrome
                  recording={recordingSkill}
                  busy={teachBusy}
                  onStop={stopTeaching}
                  variant="overlay"
                />
              ) : (
                <span
                  className="max-w-full truncate text-working font-medium text-foreground"
                  dir="auto"
                >
                  {computerLabel(computer?.mode, active.name)}
                </span>
              )}
              {!recordingSkill && hasControl ? (
                computer?.takeoverRequested ? (
                  <span className="max-w-full truncate rounded-full bg-warning/15 px-3 py-1 text-meta text-warning sm:shrink-0">
                    <Trans>Needs you</Trans>
                  </span>
                ) : (
                  <span className="max-w-full truncate rounded-full bg-success/15 px-3 py-1 text-meta text-success sm:shrink-0">
                    <Trans>You have control</Trans>
                  </span>
                )
              ) : null}
            </div>
          </div>
          <div className="app-no-drag relative flex shrink-0 items-center gap-2 sm:gap-3">
            {composerRunning ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t`Stop`}
                data-testid="computer-overlay-stop"
                onClick={() => void stopRun()}
                disabled={sending}
              >
                <Trans>Stop</Trans>
              </Button>
            ) : null}
            {recordingSkill ? (
              <TeachStopButton busy={teachBusy} onStop={stopTeaching} />
            ) : hasControl ? (
              <ComputerReleaseActions
                takeoverRequested={Boolean(computer?.takeoverRequested)}
                onRelease={releaseComputer}
              />
            ) : null}
            {active && !recordingSkill ? (
              <TeachComputerOverlayControl
                key={active.id}
                botId={active.id}
                busy={teachBusy}
                onRefresh={refreshActiveTeaching}
              >
                {(teach) => (
                  <ComputerMaintenanceActions
                    botId={active.id}
                    computer={null}
                    teach={teach}
                    onChanged={async () => {
                      await refreshThread(active.id);
                    }}
                  />
                )}
              </TeachComputerOverlayControl>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t`Close computer`}
              onClick={() => setComputerOpen(false)}
            >
              <X size={16} strokeWidth={1.8} />
            </Button>
          </div>
        </div>
        {sendError ? (
          <div
            role="alert"
            className="border-b border-destructive/40 bg-destructive/10 px-4.5 py-2 text-meta text-destructive"
          >
            {sendError}
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1 bg-background">
          {computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
            <>
              <ScreenFrame
                url={embeddedScreenUrl}
                title={t`Bot screen`}
                allow="clipboard-read; clipboard-write; fullscreen"
                interactive={!recordingSkill && hasControl}
                handlers={screenLink}
              />
              {active ? (
                <TeachCaptureOverlay
                  botId={active.id}
                  skill={recordingSkill}
                  enabled={Boolean(recordingSkill)}
                  screenWidth={computer?.screenWidth}
                  screenHeight={computer?.screenHeight}
                />
              ) : null}
            </>
          ) : (
            <div className="grid h-full place-items-center text-meta text-muted-foreground/80">
              {computerScreenError ??
                (computer?.state === "suspended"
                  ? t`Computer is asleep`
                  : computerLabel(computer?.mode, active.name))}
            </div>
          )}
        </div>
      </div>
    </div>
  ) : null;
}

function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  if (!takeoverRequested) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease()}>
        <Trans>Release</Trans>
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void onRelease("skipped")}>
        <Trans>Skip</Trans>
      </Button>
      <Button type="button" size="sm" onClick={() => void onRelease("done")}>
        <Trans>I’m done</Trans>
      </Button>
    </div>
  );
}
