import { useLingui } from "@lingui/react/macro";
import { AvatarStyleProvider } from "@rakazo/ui-web";
import { useCallback, useLayoutEffect, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ComputerUpdateProgress } from "../components/ComputerUpdateProgress";
import { authClient } from "../lib/auth";
import { markAfterPaint, markOnce } from "../lib/performance";
import { rpc } from "../lib/rpc";
import { userInitials } from "../lib/user-initials";
import { useAgentSkillCatalog } from "./shell/agent-skill-catalog";
import type { BotAction, BotCommands } from "./shell/bot-commands";
import { downloadBotExport, useBotCommands } from "./shell/bot-commands";
import { ShellMain } from "./shell/shell-main";
import { ShellOverlays } from "./shell/shell-overlays";
import { ComputerOverlay, SidePanel } from "./shell/side-panel";
import { BotsSidebar } from "./shell/sidebar";
import { useBrowserNotifications } from "./shell/use-browser-notifications";
import { useComposerDraft } from "./shell/use-composer-draft";
import { useComposerMentions } from "./shell/use-composer-mentions";
import { useComputerControl } from "./shell/use-computer-control";
import { useComputerScreen } from "./shell/use-computer-screen";
import { useCreateChat } from "./shell/use-create-chat";
import { useMobileSidebar } from "./shell/use-mobile-sidebar";
import { usePanels } from "./shell/use-panels";
import { useRoster } from "./shell/use-roster";
import { useShellOverlays } from "./shell/use-shell-overlays";
import { useSidebarState } from "./shell/use-sidebar-state";
import { useThreadSend } from "./shell/use-thread-send";
import { useThreadStore } from "./shell/use-thread-store";
import { useThreadSync } from "./shell/use-thread-sync";
import { useThreadView } from "./shell/use-thread-view";
import { useTranscriptWindow } from "./shell/use-transcript-window";
import { useVoice } from "./shell/use-voice";

export function ShellPage() {
  const { t } = useLingui();
  const { botId, groupId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const overlays = useShellOverlays(session.data?.user);
  const store = useThreadStore();
  const roster = useRoster({
    botId,
    groupId,
    navigate,
    onBootstrapThread: store.primeFromBootstrap,
  });
  const { bots, archivedBots, active, activeGroup, inGroup, bootstrapMe, refreshBots } = roster;
  const sidebar = useSidebarState({ userId, roster, navigate });
  const panels = usePanels(roster);
  const { panel, setPanel, pageBot, pickedBotId } = panels;
  const mobileSidebarOpen = useMobileSidebar({
    listRoute: !botId && !groupId,
    panelOpen: panels.panelOpen,
  });
  const screen = useComputerScreen({ panel, roster, store });
  const [agentSkills, refreshAgentSkills] = useAgentSkillCatalog(roster.activeBotId);
  const notifications = useBrowserNotifications(roster.botsRef);
  // The bot page's commands are built below from state these hooks own; reads go through the ref.
  const botCommandsRef = useRef<BotCommands>(null);
  const refreshRoutines = useCallback(
    (id: string) => botCommandsRef.current!.refreshRoutines(id),
    [],
  );
  const sync = useThreadSync({
    roster,
    store,
    screen,
    searchParams,
    notifyBrowserForEvent: notifications.notifyBrowserForEvent,
    refreshRoutines,
  });
  const thread = useThreadView(store.snapshot, roster);
  const activeSnapshot = thread.activeSnapshot;
  const shellReady =
    roster.initialBotsLoaded &&
    (inGroup
      ? Boolean(activeGroup && activeSnapshot)
      : bots.length === 0 || Boolean(active && activeSnapshot));

  // The perf marks commit before the transcript window's first scroll, as they always did.
  useLayoutEffect(() => {
    if (roster.initialBotsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && store.snapshot?.botId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (shellReady) {
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, roster.initialBotsLoaded, shellReady, store.snapshot?.botId]);

  const transcriptWindow = useTranscriptWindow({
    roster,
    store,
    viewRef: thread.viewRef,
    searchParams,
    setSearchParams,
    refreshRoutines,
    showBotPage: panels.showBotPage,
  });
  const voice = useVoice({ roster, snapshot: store.snapshot, view: thread.view, setPanel });
  const mentionTargets = useComposerMentions(roster);
  const activeTaughtSkills = store.taughtSkillsBotId === active?.id ? store.taughtSkills : [];
  const recordingSkill = activeTaughtSkills.find((skill) => skill.status === "recording") ?? null;

  const draft = useComposerDraft({ roster, thread });
  const { createBot, createGroup, cancelFocusPromptFor } = useCreateChat({
    roster,
    navigate,
    setPanel,
  });
  const send = useThreadSend({
    roster,
    store,
    sync,
    thread,
    draft,
    navigate,
    flushPendingBrowserNotifications: notifications.flushPendingBrowserNotifications,
    cancelFocusPromptFor,
  });
  const control = useComputerControl({ panel, roster, store, screen, sync });
  // The transcript is memoized, so its Needs you card calls the latest openComputer through a ref.
  const openComputerRef = useRef(control.openComputer);
  openComputerRef.current = control.openComputer;
  const openComputerFromThread = useCallback(() => void openComputerRef.current(), []);

  const userName = session.data?.user.name ?? t`You`;
  const initials = userInitials(userName);
  const userImage = session.data?.user.image ?? null;

  // The sidebar menu and the bot page's own menu run the same handlers.
  function runBotAction(botId: string, action: BotAction) {
    const bot = [...bots, ...archivedBots].find((item) => item.id === botId);
    switch (action) {
      case "duplicate":
        void rpc.bots.duplicate({ botId }).then(async (copy) => {
          await refreshBots();
          navigate(`/app/${copy.id}`);
        });
        return;
      case "export":
        void downloadBotExport(botId, bot?.name ?? "bot");
        return;
      case "clear":
        if (bot) overlays.setClearTarget({ kind: "bot", chat: bot });
        return;
      case "archive":
        // The page of a bot that just left the roster would show the next bot instead.
        if (panel === "bot" && pageBot?.id === botId) setPanel(null);
        void rpc.bots.archive({ botId }).then(() => refreshBots(true));
        return;
      case "restore":
        void rpc.bots.restore({ botId }).then(async () => {
          await refreshBots(true);
          // Restored while its page is open: the page stays, now beside the bot's own thread.
          if (panel === "bot" && pickedBotId === botId) {
            panels.setPickedBotId(null);
            navigate(`/app/${botId}`);
          }
        });
        return;
      case "delete":
        if (bot) overlays.setDeleteTarget(bot);
        return;
    }
  }
  const botCommands = useBotCommands({
    setBots: roster.setBots,
    setRoutines: store.setRoutines,
    setRoutinesBotId: store.setRoutinesBotId,
    activeBotId: roster.activeBotId,
    supersedeBotsRefresh: roster.supersedeBotsRefresh,
    botAction: runBotAction,
    refreshThread: (botId) => sync.refreshThreadRef.current(botId),
    navigate,
    panelCoversThread: panels.panelCoversThread,
    closePanel: () => setPanel(null),
    viewRun: overlays.setRunView,
    activityEpoch: sync.activityEpoch,
    refreshSkills: refreshAgentSkills,
  });
  botCommandsRef.current = botCommands;

  const shell = (
    <div
      data-testid="shell-root"
      data-ready={shellReady}
      className="rk-ambient relative flex h-full min-w-0 overflow-hidden text-foreground/90"
    >
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void sync.refreshThread(active.id);
        }}
      />
      <BotsSidebar
        {...sidebar}
        mobileSidebarOpen={mobileSidebarOpen}
        createMenuOpen={overlays.createMenuOpen}
        setCreateMenuOpen={overlays.setCreateMenuOpen}
        bots={bots}
        setPanel={setPanel}
        navigate={navigate}
        setNewSpaceOpen={overlays.setNewSpaceOpen}
        setPickerInfoTopic={overlays.setPickerInfoTopic}
        spaceMenuAnchor={overlays.spaceMenuAnchor}
        setSpaceMenu={overlays.setSpaceMenu}
        sectionMenuAnchor={overlays.sectionMenuAnchor}
        setSectionMenu={overlays.setSectionMenu}
        botSections={roster.botSections}
        spaces={roster.spaces}
        reorderRosterBot={roster.reorderRosterBot}
        bootstrapMe={bootstrapMe}
        botMenuAnchor={overlays.botMenuAnchor}
        setBotMenu={overlays.setBotMenu}
        inGroup={inGroup}
        active={active}
        activeGroup={activeGroup}
        activeSnapshot={activeSnapshot}
        initials={initials}
        userImage={userImage}
        archivedBots={archivedBots}
        archivedGroups={roster.archivedGroups}
        refreshBots={refreshBots}
        setDeleteTarget={overlays.setDeleteTarget}
        onOpenArchivedBot={panels.showArchivedBotPage}
        onRestoreBot={(botId) => runBotAction(botId, "restore")}
        setDeleteGroupTarget={overlays.setDeleteGroupTarget}
        setCustomizeOpen={overlays.setCustomizeOpen}
        menuOpen={overlays.menuOpen}
        setMenuOpen={overlays.setMenuOpen}
        userName={userName}
        openSettings={overlays.openSettings}
        setUsage={overlays.setUsage}
      />

      <ShellMain
        roster={roster}
        store={store}
        panels={panels}
        overlays={overlays}
        voice={voice}
        thread={thread}
        transcriptWindow={transcriptWindow}
        draft={draft}
        send={send}
        sync={sync}
        navigate={navigate}
        userId={userId}
        mobileSidebarOpen={mobileSidebarOpen}
        botsSidebarCollapsed={sidebar.botsSidebarCollapsed}
        setBotsSidebarCollapsedPref={sidebar.setBotsSidebarCollapsedPref}
        recording={Boolean(recordingSkill)}
        mentionTargets={mentionTargets}
        agentSkills={agentSkills}
        refreshAgentSkills={refreshAgentSkills}
        onOpenComputer={openComputerFromThread}
      />

      <SidePanel
        panel={panel}
        setPanel={setPanel}
        size={panels.panelSize}
        botPage={panels.botPage}
        onBotPage={panels.setBotPage}
        commands={botCommands}
        userId={userId ?? ""}
        pageBot={pageBot}
        active={active}
        activeGroup={activeGroup}
        computer={store.computer}
        computerOpen={screen.computerOpen}
        escapeCloses={!screen.computerOpen && !voice.callOpen}
        booting={control.booting}
        embeddedScreenUrl={screen.embeddedScreenUrl}
        computerScreenError={screen.computerScreenError}
        screenLink={screen.screenLink}
        openComputer={control.openComputer}
        refreshGroupThread={sync.refreshGroupThread}
        refreshBots={refreshBots}
        activeRoutines={!inGroup && store.routinesBotId === active?.id ? store.routines : null}
        messagingProviders={overlays.messagingProviders}
        memoryProviderConfig={overlays.memoryProviderConfig}
        bots={bots}
        groups={roster.groups}
        setGroups={roster.setGroups}
        navigate={navigate}
        createGroup={createGroup}
        createBot={createBot}
      />

      <ShellOverlays
        overlays={overlays}
        roster={roster}
        store={store}
        panels={panels}
        thread={thread}
        voice={voice}
        navigate={navigate}
        runBotAction={runBotAction}
        refreshAgentSkills={refreshAgentSkills}
        userName={userName}
        initials={initials}
        email={session.data?.user.email}
      />

      <ComputerOverlay
        booting={control.booting}
        active={active}
        computer={store.computer}
        computerOpen={screen.computerOpen}
        setComputerOpen={screen.setComputerOpen}
        computerViewport={screen.computerViewport}
        embeddedScreenUrl={screen.embeddedScreenUrl}
        computerScreenError={screen.computerScreenError}
        screenLink={screen.screenLink}
        hasControl={screen.hasControl}
        recordingSkill={recordingSkill}
        teachBusy={control.teachBusy}
        stopTeaching={control.stopTeaching}
        refreshActiveTeaching={control.refreshActiveTeaching}
        composerRunning={thread.composerRunning}
        sending={send.sending}
        stopRun={send.stopRun}
        releaseComputer={control.releaseComputer}
        refreshThread={sync.refreshThread}
        sendError={draft.sendError}
      />
    </div>
  );

  return (
    <AvatarStyleProvider value={bootstrapMe?.avatarStyle ?? "organic"}>{shell}</AvatarStyleProvider>
  );
}
