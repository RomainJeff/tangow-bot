import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  ComputerMode,
  ComputerReleaseReason,
  ComputerStatus,
  Group,
  Me,
  Routine,
  SpaceMemoryConfig,
  TaughtSkill,
  ThreadSnapshot,
} from "@rakazo/contracts";
import { cronFromPreset, isActive } from "@rakazo/core";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { Maximize2, X } from "lucide-react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { useEffect } from "react";
import { ComputerMaintenanceActions } from "../../components/ComputerMaintenanceActions";
import {
  ComputersUnavailableHint,
  computersAreUnavailable,
} from "../../components/ComputersUnavailableHint";
import { TeachCaptureOverlay } from "../../components/teach/TeachCaptureOverlay";
import { TeachComputerOverlayControl } from "../../components/teach/TeachComputerOverlay";
import { TeachRecordingChrome, TeachStopButton } from "../../components/teach/TeachRecordingChrome";
import { desktopBridge } from "../../lib/desktop";
import { localTimezone } from "../../lib/local-timezone";
import { rpc } from "../../lib/rpc";
import { computerPanelNeedsMaintenance } from "../../lib/thread-events";
import { CreateGroupForm, GroupSettings } from "../GroupPanel";
import type { RoutineDraftState } from "../RoutineEditor";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  RoutineEditor,
  RoutineListHeader,
  RoutineListRow,
  routineNeedsOneShotArm,
} from "../RoutineEditor";
import { WindowChrome } from "../WindowChrome";
import { BotSettings, CreateBotForm } from "./bot-panel";
import type { Panel } from "./layout";
import { firstThreadRoute, panelIsOpen } from "./layout";
import { ScreenFrame } from "./screen-frame";
import type { ScreenLinkHandlers } from "./use-screen-link";

export function SidePanel({
  panel,
  setPanel,
  active,
  activeGroup,
  computer,
  computerOpen,
  escapeCloses,
  booting,
  bootstrapMe,
  embeddedScreenUrl,
  computerScreenError,
  screenLink,
  openComputer,
  refreshThread,
  refreshGroupThread,
  refreshBots,
  activeRoutines,
  snapshot,
  stopRun,
  routineDraft,
  setRoutineDraft,
  editingRoutine,
  setEditingRoutine,
  routineWebhookSecret,
  setRoutineWebhookSecret,
  routineError,
  setRoutineError,
  savingRoutine,
  setSavingRoutine,
  runningRoutine,
  setRunningRoutine,
  setDeleteRoutineTarget,
  ensureWebhookSecret,
  routineSavePending,
  routineSaveRequest,
  routineRunPending,
  activeBotId,
  messagingProviders,
  memoryProviderConfig,
  bots,
  groups,
  setGroups,
  navigate,
  createGroup,
  createBot,
  setClearTarget,
}: {
  panel: Panel;
  setPanel: Dispatch<SetStateAction<Panel>>;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  /** False while a full-screen overlay or a call owns the Escape key. */
  escapeCloses: boolean;
  booting: boolean;
  bootstrapMe: Me | null | undefined;
  embeddedScreenUrl: string | null;
  computerScreenError: ReactNode;
  screenLink: ScreenLinkHandlers;
  openComputer: () => Promise<void>;
  refreshThread: (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>;
  refreshGroupThread: (id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>;
  refreshBots: (includeArchived?: boolean, replaceBotOrder?: boolean) => Promise<void>;
  activeRoutines: Routine[];
  snapshot: ThreadSnapshot | null;
  stopRun: () => Promise<void>;
  routineDraft: RoutineDraftState;
  setRoutineDraft: Dispatch<SetStateAction<RoutineDraftState>>;
  editingRoutine: Routine | null;
  setEditingRoutine: Dispatch<SetStateAction<Routine | null>>;
  routineWebhookSecret: string | null;
  setRoutineWebhookSecret: Dispatch<SetStateAction<string | null>>;
  routineError: string | null;
  setRoutineError: Dispatch<SetStateAction<string | null>>;
  savingRoutine: boolean;
  setSavingRoutine: Dispatch<SetStateAction<boolean>>;
  runningRoutine: boolean;
  setRunningRoutine: Dispatch<SetStateAction<boolean>>;
  setDeleteRoutineTarget: Dispatch<SetStateAction<Routine | null>>;
  ensureWebhookSecret: (botId: string) => Promise<string>;
  routineSavePending: RefObject<boolean>;
  routineSaveRequest: RefObject<number>;
  routineRunPending: RefObject<boolean>;
  activeBotId: RefObject<string | undefined>;
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
  setClearTarget: Dispatch<
    SetStateAction<{ kind: "bot"; chat: Bot } | { kind: "group"; chat: Group } | null>
  >;
}) {
  const { t } = useLingui();
  const open = panelIsOpen(panel, active, activeGroup);
  // The panel lies over the thread, which stays live behind it: Escape and the X
  // close it, a click outside does not. A full-screen overlay or a call owns
  // Escape while it is up, so the panel leaves the key alone then.
  useEffect(() => {
    if (!open || !escapeCloses) return;
    function close(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setPanel(null);
    }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open, escapeCloses, setPanel]);
  // Every panel closes from the same place; only some of them carry a status
  // line and the settings toggle beside it.
  const statusHeader =
    panel !== "routine" &&
    panel !== "create" &&
    panel !== "create-group" &&
    panel !== "group-settings";
  return (
    <aside
      data-testid="side-panel"
      data-panel={panel ?? "closed"}
      className={`absolute inset-y-0 end-0 z-30 flex min-h-0 shrink-0 flex-col overflow-hidden bg-surface ${
        open ? "w-full border-s border-border shadow-card lg:w-panel" : "pointer-events-none w-0"
      }`}
    >
      {open ? (
        panel === "settings" && active ? (
          <>
            <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-3">
              <span className="text-meta text-muted-foreground">
                <Trans>Settings</Trans>
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t`Close panel`}
                onClick={() => setPanel(null)}
              >
                <X size={16} strokeWidth={1.8} />
              </Button>
            </div>
            <BotSettings
              key={active.id}
              bot={active}
              memoryProviderConfigured={memoryProviderConfig != null}
              onSave={async ({ computerMode, ...patch }) => {
                if (computerMode !== active.computerMode) {
                  await rpc.bots.setComputer({ botId: active.id, mode: computerMode });
                }
                await rpc.bots.update({ botId: active.id, ...patch });
                await refreshBots();
              }}
              onExport={async () => {
                const manifest = await rpc.export.bot({ botId: active.id });
                const blob = new Blob([JSON.stringify(manifest, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${active.name.toLowerCase().replace(/\s+/g, "-")}-export.json`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              onClear={() => setClearTarget({ kind: "bot", chat: active })}
            />
          </>
        ) : (
          <>
            <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-3">
              <span className="text-meta text-muted-foreground">
                {!statusHeader ? null : panel === "settings" ? (
                  <Trans>Settings</Trans>
                ) : active ? (
                  (computer?.state ?? active.status)
                ) : (
                  <Trans>Group</Trans>
                )}
              </span>
              <div className="flex gap-1">
                {active &&
                panel === "computer" &&
                !computerOpen &&
                computerPanelNeedsMaintenance(computer?.state, booting) ? (
                  <ComputerMaintenanceActions
                    botId={active.id}
                    computer={computer}
                    onChanged={async () => {
                      await refreshThread(active.id);
                    }}
                  />
                ) : null}
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
                <div>
                  <div
                    data-testid="computer-preview"
                    className="group relative aspect-[16/10] overflow-hidden rounded-card bg-background"
                  >
                    {computerOpen ? (
                      <div className="grid h-full place-items-center text-meta text-muted-foreground/80">
                        <Trans>Open in full window</Trans>
                      </div>
                    ) : computer?.kind === "desktop" ? (
                      <DesktopKindEmptyState className="grid h-full place-items-center px-6 text-center text-meta text-muted-foreground/80" />
                    ) : computer?.state === "running" &&
                      embeddedScreenUrl &&
                      !computerScreenError ? (
                      <ScreenFrame
                        url={embeddedScreenUrl}
                        title={t`Bot screen preview`}
                        allow="clipboard-read; clipboard-write"
                        interactive={false}
                        handlers={screenLink}
                      />
                    ) : (
                      <div className="grid h-full place-items-center px-6 text-center text-meta text-muted-foreground/80">
                        {computerScreenError ??
                          (computersAreUnavailable(bootstrapMe?.sandboxProvider) ? (
                            <ComputersUnavailableHint />
                          ) : (
                            computerPlaceholder(
                              computer?.state,
                              booting,
                              computerLabel(computer?.mode, active.name),
                            )
                          ))}
                      </div>
                    )}
                    {!computerScreenError ? (
                      <button
                        type="button"
                        data-testid="computer-preview-open"
                        className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={t`Open`}
                        onClick={() => void openComputer()}
                      >
                        <span className="inline-flex items-center gap-2 rounded-full bg-overlay px-3.5 py-2 text-capsule text-foreground shadow-floating">
                          <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
                          <Trans>Open</Trans>
                        </span>
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-2 truncate text-reasoning text-muted-foreground" dir="auto">
                    {t`${active.name}'s screen`}
                  </p>
                  <RoutineListHeader
                    onCreate={() => {
                      setRoutineDraft(emptyRoutineDraft());
                      setRoutineWebhookSecret(null);
                      setEditingRoutine(null);
                      setRoutineError(null);
                      setPanel("routine");
                    }}
                  />
                  {activeRoutines.map((routine) => {
                    const routineRunning =
                      snapshot?.run?.routineId === routine.id && isActive(snapshot.run.status);
                    return (
                      <RoutineListRow
                        key={routine.id}
                        routine={routine}
                        running={routineRunning}
                        onOpen={() => {
                          setRoutineDraft(draftFromRoutine(routine));
                          setRoutineWebhookSecret(null);
                          setEditingRoutine(routine);
                          setRoutineError(null);
                          setPanel("routine");
                        }}
                        onStop={() => void stopRun()}
                      />
                    );
                  })}
                </div>
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
                    const updated = await rpc.groups.update({ groupId: activeGroup.id, ...input });
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
              {panel === "routine" && active ? (
                <RoutineEditor
                  draft={routineDraft}
                  onChange={setRoutineDraft}
                  editing={editingRoutine}
                  timezone={editingRoutine?.timezone ?? localTimezone()}
                  webhook={{
                    path:
                      typeof window !== "undefined"
                        ? `${window.location.origin}/api/v1/bots/${active.id}/webhook`
                        : `/api/v1/bots/${active.id}/webhook`,
                    secret: routineWebhookSecret,
                    configured: active.webhookConfigured || Boolean(routineWebhookSecret),
                  }}
                  githubPath={
                    typeof window !== "undefined"
                      ? `${window.location.origin}/api/v1/bots/${active.id}/github`
                      : `/api/v1/bots/${active.id}/github`
                  }
                  messageProviders={messagingProviders}
                  saving={savingRoutine}
                  running={runningRoutine}
                  error={routineError}
                  onBack={() => setPanel("computer")}
                  onClose={() => setPanel(null)}
                  onEnsureWebhook={async () => {
                    await ensureWebhookSecret(active.id);
                  }}
                  onSave={async () => {
                    if (routineSavePending.current) return;
                    const targetBotId = active.id;
                    const targetRoutine = editingRoutine;
                    if (targetRoutine && targetRoutine.botId !== targetBotId) return;
                    if (
                      !routineDraft.schedules.length &&
                      !routineDraft.webhookEnabled &&
                      !routineDraft.githubEnabled &&
                      !routineDraft.messageProvider
                    ) {
                      setRoutineError(t`Add a schedule, webhook, GitHub, or message trigger`);
                      return;
                    }
                    const saveRequest = ++routineSaveRequest.current;
                    routineSavePending.current = true;
                    setSavingRoutine(true);
                    setRoutineError(null);
                    try {
                      if (
                        (routineDraft.webhookEnabled || routineDraft.githubEnabled) &&
                        !active.webhookConfigured &&
                        !routineWebhookSecret
                      ) {
                        await ensureWebhookSecret(targetBotId);
                      }
                      const crons = routineDraft.schedules.map(cronFromPreset);
                      let saved: Routine;
                      if (targetRoutine) {
                        const armOneShot = routineNeedsOneShotArm(targetRoutine, crons);
                        let runAt: string | undefined;
                        if (armOneShot) {
                          if (!routineDraft.runAtLocal) {
                            setRoutineError(t`Add a run time for this one-shot.`);
                            return;
                          }
                          const parsed = new Date(routineDraft.runAtLocal);
                          if (
                            !Number.isFinite(parsed.getTime()) ||
                            parsed.getTime() <= Date.now()
                          ) {
                            setRoutineError(t`Run time must be in the future.`);
                            return;
                          }
                          runAt = parsed.toISOString();
                        }
                        saved = await rpc.routines.update({
                          routineId: targetRoutine.id,
                          name: routineDraft.name || t`Routine`,
                          prompt: routineDraft.prompt || t`Check in.`,
                          crons,
                          active: armOneShot ? true : routineDraft.active,
                          notify: routineDraft.notify,
                          webhookEnabled: routineDraft.webhookEnabled,
                          githubEnabled: routineDraft.githubEnabled,
                          messageProvider: routineDraft.messageProvider,
                          requireToolApproval: routineDraft.requireToolApproval,
                          ...(runAt ? { runAt } : {}),
                        });
                      } else {
                        saved = await rpc.routines.create({
                          botId: targetBotId,
                          name: routineDraft.name || t`Routine`,
                          prompt: routineDraft.prompt || t`Check in.`,
                          crons,
                          timezone: localTimezone(),
                          active: routineDraft.active,
                          notify: routineDraft.notify,
                          webhookEnabled: routineDraft.webhookEnabled,
                          githubEnabled: routineDraft.githubEnabled,
                          messageProvider: routineDraft.messageProvider,
                          requireToolApproval: routineDraft.requireToolApproval,
                        });
                      }
                      if (
                        routineSaveRequest.current === saveRequest &&
                        activeBotId.current === targetBotId
                      ) {
                        setEditingRoutine(saved);
                        setRoutineDraft(draftFromRoutine(saved));
                      }
                    } catch (error) {
                      if (
                        routineSaveRequest.current !== saveRequest ||
                        activeBotId.current !== targetBotId
                      ) {
                        return;
                      }
                      setRoutineError(
                        error instanceof Error ? error.message : t`Could not save routine`,
                      );
                      return;
                    } finally {
                      routineSavePending.current = false;
                      setSavingRoutine(false);
                    }
                    if (
                      routineSaveRequest.current !== saveRequest ||
                      activeBotId.current !== targetBotId
                    ) {
                      return;
                    }
                    await refreshThread(targetBotId).catch(() => undefined);
                  }}
                  onTestRun={async () => {
                    if (routineRunPending.current) return;
                    const targetBotId = active.id;
                    const targetRoutine = editingRoutine;
                    if (!targetRoutine) return;
                    routineRunPending.current = true;
                    setRunningRoutine(true);
                    setRoutineError(null);
                    try {
                      await rpc.routines.testRun({ routineId: targetRoutine.id });
                      await refreshThread(targetBotId);
                    } catch (error) {
                      if (activeBotId.current === targetBotId) {
                        setRoutineError(
                          error instanceof Error ? error.message : t`Could not run routine`,
                        );
                      }
                    } finally {
                      routineRunPending.current = false;
                      setRunningRoutine(false);
                    }
                  }}
                  onDelete={() => {
                    if (editingRoutine) {
                      setDeleteRoutineTarget(editingRoutine);
                      return;
                    }
                    setPanel("computer");
                  }}
                />
              ) : null}
            </div>
          </>
        )
      ) : null}
    </aside>
  );
}

function DesktopKindEmptyState({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Trans>
        This bot runs on this computer, not a Linux desktop. Shell and files use your home folder.
      </Trans>
    </div>
  );
}

function computerPlaceholder(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  label: string,
) {
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return label;
  if (state === "suspended") return t`Computer is asleep. Open it to wake.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}

function computerLabel(mode: ComputerStatus["mode"] | undefined, botName: string) {
  return mode === "dedicated" ? t`${botName}’s computer` : t`Team Computer`;
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
            {recordingSkill ? (
              <TeachRecordingChrome
                recording={recordingSkill}
                busy={teachBusy}
                onStop={stopTeaching}
                variant="overlay"
              />
            ) : (
              <span className="truncate text-working font-medium text-foreground" dir="auto">
                {computerLabel(computer?.mode, active.name)}
              </span>
            )}
            {!recordingSkill && hasControl ? (
              computer?.takeoverRequested ? (
                <span className="rounded-full bg-warning/15 px-3 py-1 text-meta text-warning">
                  <Trans>Needs you</Trans>
                </span>
              ) : (
                <span className="rounded-full bg-success/15 px-3 py-1 text-meta text-success">
                  <Trans>You have control</Trans>
                </span>
              )
            ) : null}
          </div>
          <div className="app-no-drag flex items-center gap-3">
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
                computer={computer}
                busy={teachBusy}
                onRefresh={refreshActiveTeaching}
              />
            ) : null}
            {active && !recordingSkill ? (
              <ComputerMaintenanceActions
                botId={active.id}
                computer={computer}
                onChanged={async () => {
                  await refreshThread(active.id);
                }}
              />
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
          {computer?.kind === "desktop" ? (
            <DesktopKindEmptyState className="grid h-full place-items-center px-8 text-center text-meta text-muted-foreground/80" />
          ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
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
