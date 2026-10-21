import { Trans, useLingui } from "@lingui/react/macro";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { Pencil, Trash2 } from "lucide-react";
import { lazy, Suspense } from "react";
import type { NavigateFunction } from "react-router-dom";
import { rpc, selectedSpaceId, selectSpace } from "../../lib/rpc";
import type { BotAction } from "./bot-commands";
import { CommandPalette } from "./command-palette";
import {
  ClearConversationDialog,
  DeleteBotDialog,
  DeleteItemDialog,
  NewBotSectionDialog,
  NewSpaceDialog,
  PickerInfoDialog,
  RenameBotSectionDialog,
} from "./dialogs";
import { botPageFor, FALLBACK_BOT_COLOR } from "./layout";
import type { Panels } from "./use-panels";
import type { Roster } from "./use-roster";
import type { ShellOverlayState } from "./use-shell-overlays";
import type { ThreadStore } from "./use-thread-store";
import type { ThreadViewState } from "./use-thread-view";
import type { Voice } from "./use-voice";

const BotContextMenu = lazy(() =>
  import("../BotContextMenu").then((module) => ({ default: module.BotContextMenu })),
);
const MessagingSettingsOverlay = lazy(() =>
  import("../MessagingSettingsOverlay").then((module) => ({
    default: module.MessagingSettingsOverlay,
  })),
);
const SettingsOverlay = lazy(() =>
  import("../SettingsOverlay").then((module) => ({ default: module.SettingsOverlay })),
);
const PeerMessagesOverlay = lazy(() =>
  import("../PeerMessagesOverlay").then((module) => ({ default: module.PeerMessagesOverlay })),
);
const CustomizeOverlay = lazy(() =>
  import("../CustomizeOverlay").then((module) => ({ default: module.CustomizeOverlay })),
);
const McpServersOverlay = lazy(() =>
  import("../McpServersOverlay").then((module) => ({ default: module.McpServersOverlay })),
);

/** Everything that opens over the shell: context menus, confirmations, palette and overlays. */
export function ShellOverlays({
  overlays,
  roster,
  store,
  panels,
  thread,
  voice,
  navigate,
  runBotAction,
  refreshAgentSkills,
  userName,
  initials,
  email,
}: {
  overlays: ShellOverlayState;
  roster: Roster;
  store: ThreadStore;
  panels: Panels;
  thread: ThreadViewState;
  voice: Voice;
  navigate: NavigateFunction;
  runBotAction: (botId: string, action: BotAction) => void;
  refreshAgentSkills: () => void;
  userName: string;
  initials: string;
  email: string | undefined;
}) {
  const { t } = useLingui();
  const { bots, groups, setGroups, botSections, spaces, bootstrapMe, refreshBots } = roster;
  const { active, activeGroup } = roster;
  const { setPanel, showBotPage } = panels;
  const { botMenu, setBotMenu, closeBotMenu, spaceMenu, setSpaceMenu, closeSpaceMenu } = overlays;
  const { sectionMenu, setSectionMenu, closeSectionMenu } = overlays;
  const { deleteTarget, setDeleteTarget, deleteGroupTarget, setDeleteGroupTarget } = overlays;
  const { deleteSpaceTarget, setDeleteSpaceTarget, clearTarget, setClearTarget } = overlays;
  const { newSectionTarget, setNewSectionTarget } = overlays;
  const { renameSectionTarget, setRenameSectionTarget } = overlays;
  const { peerConversation, setPeerConversation } = overlays;
  const contextBot =
    botMenu?.kind === "bot" ? bots.find((bot) => bot.id === botMenu.id) : undefined;
  const contextGroup =
    botMenu?.kind === "group" ? groups.find((group) => group.id === botMenu.id) : undefined;
  const contextChat = contextBot ?? contextGroup;

  return (
    <>
      <Suspense fallback={null}>
        {contextChat && botMenu ? (
          <BotContextMenu
            bot={contextChat}
            position={botMenu.position}
            onClose={closeBotMenu}
            sections={botSections}
            onTogglePinned={() => {
              setBotMenu(null);
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, pinned: !contextBot.pinned })
                : rpc.groups.update({
                    groupId: contextGroup!.id,
                    pinned: !contextGroup!.pinned,
                  });
              void request.then(() => refreshBots());
            }}
            onToggleUnread={() => {
              const unread = !contextChat.unread;
              setBotMenu(null);
              if (contextBot) {
                const request = unread
                  ? roster.markBotUnread(contextBot.id)
                  : roster.markBotRead(contextBot.id);
                void request.catch(() => undefined);
              } else {
                const request = unread
                  ? rpc.threads.markUnread({ groupId: contextGroup!.id })
                  : rpc.threads.markRead({ groupId: contextGroup!.id });
                void request
                  .then(() =>
                    setGroups((current) =>
                      current.map((group) =>
                        group.id === contextGroup!.id ? { ...group, unread } : group,
                      ),
                    ),
                  )
                  .catch(() => undefined);
              }
            }}
            onMoveToSection={(sectionId) => {
              setBotMenu(null);
              if (sectionId === contextChat.sectionId) return;
              const request = contextBot
                ? rpc.bots.update({ botId: contextBot.id, sectionId })
                : rpc.groups.update({ groupId: contextGroup!.id, sectionId });
              void request.then(() => refreshBots());
            }}
            onCreateSection={() => {
              setNewSectionTarget(
                contextBot
                  ? { kind: "bot", chat: contextBot }
                  : { kind: "group", chat: contextGroup! },
              );
              setBotMenu(null);
            }}
            onRenameSection={(sectionId) => {
              const section = botSections.find((item) => item.id === sectionId);
              const spaceId = bootstrapMe?.spaceId;
              if (section && spaceId) setRenameSectionTarget({ section, spaceId });
              setBotMenu(null);
            }}
            editLabel={contextBot ? t`Bot settings` : t`Edit Profile`}
            onEdit={() => {
              setBotMenu(null);
              if (contextBot) {
                navigate(`/app/${contextBot.id}`);
                showBotPage(botPageFor("menu", contextBot));
                return;
              }
              navigate(`/app/g/${contextGroup!.id}`);
              setPanel("group-settings");
            }}
            onDuplicate={() => {
              setBotMenu(null);
              if (contextBot) {
                runBotAction(contextBot.id, "duplicate");
                return;
              }
              void rpc.groups.duplicate({ groupId: contextGroup!.id }).then(async (chat) => {
                await refreshBots();
                navigate(`/app/g/${chat.id}`);
              });
            }}
            onClear={() => {
              setBotMenu(null);
              if (contextBot) runBotAction(contextBot.id, "clear");
              else setClearTarget({ kind: "group", chat: contextGroup! });
            }}
            onArchive={() => {
              setBotMenu(null);
              if (contextBot) {
                runBotAction(contextBot.id, "archive");
                return;
              }
              void rpc.groups.archive({ groupId: contextGroup!.id }).then(() => refreshBots(true));
            }}
            onDelete={() => {
              setBotMenu(null);
              if (contextBot) runBotAction(contextBot.id, "delete");
              else setDeleteGroupTarget(contextGroup!);
            }}
          />
        ) : null}

        {spaceMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSpaceMenu();
            }}
          >
            {/* Invisible anchor at the pointer position, mirroring the bot menu. */}
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: spaceMenu.position.x, top: spaceMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for space`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  const target = spaces.find((space) => space.id === spaceMenu.id);
                  if (target) setDeleteSpaceTarget(target);
                  setSpaceMenu(null);
                }}
              >
                <Trash2 />
                {t`Delete space`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {deleteTarget ? (
          <DeleteBotDialog
            bot={deleteTarget}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={async (deleteMemories) => {
              await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
              setDeleteTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {deleteGroupTarget ? (
          <DeleteItemDialog
            item={deleteGroupTarget}
            noun="group"
            onCancel={() => setDeleteGroupTarget(null)}
            onConfirm={async () => {
              await rpc.groups.remove({ groupId: deleteGroupTarget.id });
              setDeleteGroupTarget(null);
              setPanel(null);
              await refreshBots(true);
            }}
          />
        ) : null}

        {deleteSpaceTarget ? (
          <DeleteItemDialog
            item={deleteSpaceTarget}
            noun="space"
            description={
              <Trans>Only empty spaces can be deleted. Delete its bots and groups first.</Trans>
            }
            onCancel={() => setDeleteSpaceTarget(null)}
            onConfirm={async () => {
              const targetId = deleteSpaceTarget.id;
              const result = await rpc.spaces.remove({ spaceId: targetId });
              setDeleteSpaceTarget(null);
              setPanel(null);
              const effectiveSpaceId = selectedSpaceId() ?? bootstrapMe?.spaceId;
              if (effectiveSpaceId === targetId) {
                // The auth boundary changed, so reload like a space switch.
                if (selectSpace(result.activeSpaceId)) {
                  window.location.assign("/app");
                  return;
                }
              }
              await refreshBots(true);
            }}
          />
        ) : null}

        {newSectionTarget ? (
          <NewBotSectionDialog
            bot={newSectionTarget.chat}
            onCancel={() => setNewSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.create(
                newSectionTarget.kind === "bot"
                  ? { botId: newSectionTarget.chat.id, name }
                  : { groupId: newSectionTarget.chat.id, name },
              );
              setNewSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {renameSectionTarget ? (
          <RenameBotSectionDialog
            section={renameSectionTarget.section}
            onCancel={() => setRenameSectionTarget(null)}
            onConfirm={async (name) => {
              await rpc.botSections.update(
                {
                  sectionId: renameSectionTarget.section.id,
                  name,
                },
                { context: { spaceId: renameSectionTarget.spaceId } },
              );
              setRenameSectionTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {sectionMenu ? (
          <DropdownMenu
            open
            onOpenChange={(open) => {
              if (!open) closeSectionMenu();
            }}
          >
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  className="fixed size-0 p-0 opacity-0"
                  style={{ left: sectionMenu.position.x, top: sectionMenu.position.y }}
                />
              }
            />
            <DropdownMenuContent
              aria-label={t`Actions for ${sectionMenu.section.name}`}
              align="start"
              sideOffset={0}
              className="w-[220px]"
            >
              <DropdownMenuItem
                onClick={() => {
                  setRenameSectionTarget({
                    section: sectionMenu.section,
                    spaceId: sectionMenu.spaceId,
                  });
                  setSectionMenu(null);
                }}
              >
                <Pencil />
                {t`Rename section`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <CommandPalette
          open={overlays.commandPaletteOpen}
          onOpenChange={overlays.setCommandPaletteOpen}
          bots={bots}
          onSelectBot={(id) => {
            navigate(`/app/${id}`);
          }}
        />

        {overlays.newSpaceOpen ? (
          <NewSpaceDialog
            onCancel={() => overlays.setNewSpaceOpen(false)}
            onConfirm={async (name) => {
              const space = await rpc.spaces.create({ name });
              if (!selectSpace(space.id)) {
                overlays.setNewSpaceOpen(false);
                await refreshBots();
                return;
              }
              window.location.assign("/onboarding");
            }}
          />
        ) : null}

        {overlays.pickerInfoTopic ? (
          <PickerInfoDialog
            topic={overlays.pickerInfoTopic}
            onClose={() => overlays.setPickerInfoTopic(null)}
          />
        ) : null}

        {clearTarget ? (
          <ClearConversationDialog
            bot={clearTarget.chat}
            onCancel={() => setClearTarget(null)}
            onConfirm={async () => {
              await rpc.threads.clear(
                clearTarget.kind === "bot"
                  ? { botId: clearTarget.chat.id }
                  : { groupId: clearTarget.chat.id },
              );
              if (
                (clearTarget.kind === "bot" && active?.id === clearTarget.chat.id) ||
                (clearTarget.kind === "group" && activeGroup?.id === clearTarget.chat.id)
              ) {
                store.leaveJumpWindow();
                store.historyEpoch.current += 1;
                store.updateSnapshot((current) => (current ? { ...current, run: null } : current));
              }
              setClearTarget(null);
              await refreshBots();
            }}
          />
        ) : null}

        {overlays.customizeOpen ? (
          <CustomizeOverlay
            activeBotId={roster.activeBotId.current}
            onClose={() => overlays.setCustomizeOpen(false)}
            onOpenMcp={() => {
              overlays.setCustomizeOpen(false);
              overlays.setMcpOpen(true);
            }}
            onSkillsChanged={refreshAgentSkills}
          />
        ) : null}
        {overlays.mcpOpen ? <McpServersOverlay onClose={() => overlays.setMcpOpen(false)} /> : null}
        {overlays.messagingSettingsOpen ? (
          <MessagingSettingsOverlay onClose={() => overlays.setMessagingSettingsOpen(false)} />
        ) : null}
      </Suspense>

      <Suspense fallback={null}>
        {overlays.settingsOpen ? (
          <SettingsOverlay
            name={userName}
            initials={initials}
            email={email}
            usage={overlays.usage}
            initialSection={overlays.settingsSection}
            avatarStyle={bootstrapMe?.avatarStyle ?? "organic"}
            isDeploymentOwner={bootstrapMe?.isDeploymentOwner === true}
            sandboxProvider={bootstrapMe?.sandboxProvider}
            messagingEnabled={overlays.messagingSurfaceEnabled}
            onOpenMessaging={() => {
              overlays.setSettingsOpen(false);
              overlays.setMessagingSettingsOpen(true);
            }}
            onAvatarStyleChange={async (avatarStyle) => {
              const nextMe = await rpc.preferences.update({ avatarStyle });
              roster.setBootstrapMe(nextMe);
            }}
            memoryConfig={overlays.memoryProviderConfig}
            onMemoryConfigChange={overlays.changeMemoryConfig}
            onVoiceStatusMaybeChanged={voice.refreshVoiceStatus}
            onClose={() => {
              overlays.setSettingsOpen(false);
              overlays.setSettingsSection("general");
            }}
          />
        ) : null}
        {peerConversation && active ? (
          <PeerMessagesOverlay
            botId={active.id}
            botName={active.name}
            botColor={active.color}
            botShapeSeed={active.shapeSeed}
            peerBotId={peerConversation.peerBotId}
            peerBotName={peerConversation.peerBotName}
            peerBotColor={
              thread.resolveTranscriptBot(peerConversation.peerBotId)?.color ?? FALLBACK_BOT_COLOR
            }
            peerBotShapeSeed={thread.resolveTranscriptBot(peerConversation.peerBotId)?.shapeSeed}
            onClose={() => setPeerConversation(null)}
          />
        ) : null}
      </Suspense>
    </>
  );
}
