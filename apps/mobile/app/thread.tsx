import { ChatMarkdown, truncateMarkdownForRender } from "@rakazo/chat-ui/native";
import type {
  AgentSkillCatalogEntry,
  Connection,
  ConnectionCatalogItem,
  MessageBlock,
  Routine,
} from "@rakazo/contracts";
import {
  canReactToThreadMessage,
  MESSAGE_REACTIONS,
  type MessageReaction,
} from "@rakazo/contracts";
import {
  abortableDelay,
  attachmentsForThread,
  buildComposerMentionOptions,
  type ComposerMention,
  cloudAgentHttpsUrl,
  isApprovalAskBlock,
  isAsideOnlyMessage,
  isRunTerminalEvent,
  isSecretAskBlock,
  latestActivityLabel,
  latestAnswerableAskMessageId,
  mentionChipKey,
  projectMessageReactions,
  resolveComposerSendPlan,
  SLASH_ACTIONS,
  type SlashActionId,
  selectedAskActionLabel,
  serializeComposerPrompt,
  showsTimeMarker,
  threadTimeMarkerLabel,
  truncateSlashDescription,
  userVisibleMessages,
} from "@rakazo/core";
import { radii, sizes } from "@rakazo/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  Linking,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextProps,
  View,
  type ViewStyle,
} from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppConnectCard } from "../components/AppConnectCard";
import {
  AskActions,
  CapsuleButton,
  QuickReplyCapsules,
  TERTIARY_CAPSULE_HEIGHT,
} from "../components/AskActions";
import { AgentSteps } from "../components/agent-steps";
import { BotAvatar } from "../components/bot-avatar";
import { ComposerShell } from "../components/composer-shell";
import { FramedBlock } from "../components/framed-block";
import { GroupAvatar } from "../components/group-avatar";
import { Interstitial } from "../components/interstitial";
import {
  MarkdownArtifactPreview,
  type MarkdownArtifactPreviewTarget,
} from "../components/markdown-artifact-preview";
import { MessageRow } from "../components/message-row";
import { NativeSymbol } from "../components/native-symbol";
import { ShimmerText } from "../components/shimmer-text";
import { StackedAvatars } from "../components/stacked-avatars";
import { Surface } from "../components/surface";
import { UserBubble } from "../components/user-bubble";
import { WorkingLine } from "../components/working-line";
import { useDisplayAgentSteps } from "../lib/agent-steps-pref";
import {
  applyMobileThreadEvent,
  blockText,
  copyableMobileMessageText,
  currentApiBase,
  earliestRunStartMs,
  loadSessionToken,
  type MobileBot,
  type MobileGroup,
  type MobileMessage,
  type MobileMessagePage,
  type MobileSnapshot,
  mergeMobileSnapshot,
  messagingProviderLabel,
  prependMobileMessagePage,
  rpc,
  selectedSpaceId,
  selectSpace,
  shouldApplyMobileThreadRefresh,
  subscribeThread,
} from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { type MobileArtifactTarget, openMobileArtifact } from "../lib/artifact-open";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import { cancelFocusPrompt, focusPromptThreadActive } from "../lib/focus-prompt";
import { dateLocaleForUi, t, useI18n } from "../lib/i18n";
import { saveLastBotId } from "../lib/last-bot";
import {
  dismissThreadNotifications,
  resumeLiveNotifications,
  setOpenNotificationThread,
} from "../lib/live-notifications";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import {
  hasVisibleMessagePresentation,
  messagePresentationSegments,
  stepsBlocks,
  visibleMessageBlocks,
} from "../lib/message-presentation";
import { native, useMobileTokens, useResolvedAppearance } from "../lib/native";
import {
  type PickedAttachment,
  pickDocuments,
  pickFromLibrary,
  takePhoto,
} from "../lib/pick-attachments";
import { threadRefreshDelayMs } from "../lib/refresh";
import {
  type ThreadScrollAction,
  ThreadScrollBehavior,
  type ThreadScrollState,
} from "../lib/thread-scroll";
import { nativeTextStyle } from "../lib/typography";
import { speakText } from "../lib/voice";

type PendingAttachment = PickedAttachment & { threadKey: string };
type AskAction = NonNullable<Extract<MessageBlock, { kind: "ask" }>["actions"]>[number];

/**
 * How the thread frames a message, derived from the blocks it is about to draw
 * — same two shapes as the web transcript. `row` is something a bot or the
 * person said (a bot's question or approval is a normal row too, its
 * FramedBlock card is just the row's body), `aside` a quiet note between
 * messages.
 */
type MessageChrome = "row" | "aside";

/** Gaps from the design contract's space scale: 28 between messages, 22 for
 * the quieter asides. */
const MESSAGE_GAP = 28;
const ASIDE_GAP = 22;
/** Avatar column plus its gap: a bot row's reactions line up under its prose. */
const FRAMED_INDENT = sizes.message + 11;

/** The 30 pt capsule a mention or a skill rides in, inside the composer. */
const composerChip: ViewStyle = {
  flexDirection: "row",
  alignItems: "center",
  gap: 6,
  height: 30,
  borderRadius: radii.pill,
  paddingStart: 5,
  paddingEnd: 10,
  maxWidth: "100%",
};

function newClientNonce(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatApprovalAnswer(
  answer: string | undefined,
  actions: AskAction[] | undefined,
  approval: boolean,
): string {
  if (!answer) return t("Answered");
  const selectedAction = actions?.find((action) => action.id === answer);
  const outcome = selectedAction?.outcome;
  if (approval && outcome === "created") return t("Created");
  if (approval && outcome === "cancelled") return t("Cancelled");
  if (approval && answer === "allow") return t("Allowed once");
  if (approval && answer === "always") return t("Always allowed");
  if (approval && answer === "deny") return t("Denied");
  return t("Answered: {answer}", {
    answer: selectedAskActionLabel(answer, actions),
  });
}

function formatAttachmentSkip(item: { name: string; reason: string }): string {
  const name = item.name === "camera" ? t("Camera") : item.name;
  if (item.reason === "permission denied") return t("{name} (permission denied)", { name });
  if (item.reason === "over 10 MiB") return t("{name} (over 10 MiB)", { name });
  if (item.reason === "unsupported type") return t("{name} (unsupported type)", { name });
  const maxMatch = /^max (\d+) attachments$/.exec(item.reason);
  if (maxMatch) {
    return t("{name} (max {count} attachments)", {
      name,
      count: maxMatch[1] ?? "",
    });
  }
  return `${name} (${item.reason})`;
}

/** The clock beside a bot's name, and the title of the message action sheet. */
function messageClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(dateLocaleForUi(), {
    hour: "numeric",
    minute: "2-digit",
  });
}

function isWorkingStatus(status: string | undefined): boolean {
  return (
    status === "queued" ||
    status === "leased" ||
    status === "running" ||
    status === "waiting_input" ||
    status === "waiting_takeover"
  );
}

type NotificationRouteState = "loading" | "ready" | "failed";

export default function ThreadRoute() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const { spaceId } = useLocalSearchParams<{ spaceId?: string | string[] }>();
  const requestedSpaceId = typeof spaceId === "string" && spaceId ? spaceId : null;
  const invalidSpaceId = spaceId !== undefined && requestedSpaceId === null;
  const routeMatchesSelectedSpace =
    requestedSpaceId === null || selectedSpaceId() === requestedSpaceId;
  const [routeState, setRouteState] = useState<NotificationRouteState>(() => {
    if (invalidSpaceId) return "failed";
    return routeMatchesSelectedSpace ? "ready" : "loading";
  });

  useEffect(() => {
    let cancelled = false;
    if (invalidSpaceId) {
      setRouteState("failed");
      return () => {
        cancelled = true;
      };
    }
    if (!requestedSpaceId || selectedSpaceId() === requestedSpaceId) {
      setRouteState("ready");
      return () => {
        cancelled = true;
      };
    }
    setRouteState("loading");
    void selectSpace(requestedSpaceId).then((selected) => {
      if (!cancelled) setRouteState(selected ? "ready" : "failed");
    });
    return () => {
      cancelled = true;
    };
  }, [invalidSpaceId, requestedSpaceId]);

  if (routeState === "ready" && !invalidSpaceId && routeMatchesSelectedSpace) return <Thread />;
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tokens.background,
      }}
    >
      {routeState === "loading" ? (
        <ActivityIndicator color={tokens.foreground} />
      ) : (
        <Pressable accessibilityRole="button" onPress={() => router.replace("/")}>
          <Text style={{ color: tokens.foreground, fontSize: 16 }}>{t("Return to inbox")}</Text>
        </Pressable>
      )}
    </View>
  );
}

function Thread() {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const [botActionsOpen, setBotActionsOpen] = useState(false);
  const { t } = useI18n();
  const navigation = useNavigation();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { botId, groupId, name, messageId } = useLocalSearchParams<{
    botId?: string;
    groupId?: string;
    name?: string;
    messageId?: string;
  }>();
  const inGroup = Boolean(groupId);
  const scroll = useRef<FlatList<MobileMessage>>(null);
  const pinnedScroll = useRef<ScrollView>(null);
  const scrollBehavior = useRef(new ThreadScrollBehavior());
  const userDragging = useRef(false);
  const loadingOlderContent = useRef(false);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const jumpGeneration = useRef(0);
  const pinnedAroundRef = useRef<{
    botId?: string;
    groupId?: string;
    messageId: string;
    threadId: string;
    messages: readonly MobileMessage[];
    olderCursor: number | null;
  } | null>(null);
  const jumpScrollTarget = useRef<string | null>(null);
  const activeBotId = useRef(botId);
  activeBotId.current = botId;
  const activeGroupId = useRef(groupId);
  activeGroupId.current = groupId;
  const routeName = useRef(name);
  routeName.current = name;
  const mentionBotsRefreshGeneration = useRef(0);
  const mentionBotsAppliedGeneration = useRef(0);
  const readVisibleTarget = useRef<string | null>(null);
  const threadKey = groupId ?? botId;
  const [threadScrollState, setThreadScrollState] = useState<ThreadScrollState>(() =>
    scrollBehavior.current.state(),
  );
  useLayoutEffect(() => {
    scrollBehavior.current.openThread(threadKey ?? "");
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    jumpScrollTarget.current = null;
    loadingOlderContent.current = false;
    setThreadScrollState(scrollBehavior.current.state());
  }, [threadKey]);
  const reducedMotion = useReducedMotion();
  const artifactTarget: MobileArtifactTarget | undefined = groupId
    ? { groupId }
    : botId
      ? { botId }
      : undefined;
  const [snap, setSnap] = useState<MobileSnapshot | null>(null);
  const activeThreadId = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [mentionBots, setMentionBots] = useState<MobileBot[]>([]);
  const [mentionGroups, setMentionGroups] = useState<MobileGroup[]>([]);
  const [mentionRoutines, setMentionRoutines] = useState<Array<Routine & { botName?: string }>>([]);
  const [mentionConnectors, setMentionConnectors] = useState<
    Array<{
      id: string;
      name: string;
      authStatus: "connected" | "needs_auth";
      connectionId?: string;
    }>
  >([]);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [replyTarget, setReplyTarget] = useState<MobileMessage | null>(null);
  const [rewindTarget, setRewindTarget] = useState<MobileMessage | null>(null);
  // ponytail: artifact ids ride along invisibly — mobile has no attachment chips to restore into.
  const [rewindArtifactIds, setRewindArtifactIds] = useState<string[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownArtifactPreviewTarget | null>(
    null,
  );
  const showSteps = useDisplayAgentSteps();
  const reactionView = useMemo(
    () =>
      projectMessageReactions(
        userVisibleMessages(snap?.messages ?? [], { includePeerReceipts: true }).filter((message) =>
          hasVisibleMessagePresentation(message.blocks, showSteps),
        ),
      ),
    [snap?.messages, showSteps],
  );
  const visibleMessages = reactionView.visibleMessages;
  const latestMessageId = visibleMessages.at(-1)?.id ?? null;
  const rewindRemovedCount = rewindTarget
    ? visibleMessages.filter((message) => (message.seq ?? 0) > (rewindTarget.seq ?? 0)).length
    : 0;
  const activePendingAttachments = attachmentsForThread(pendingAttachments, threadKey);
  const composerMentionTargets = useMemo(
    () =>
      buildComposerMentionOptions({
        query: "",
        includeEveryone: inGroup,
        currentGroupId: groupId,
        bots: mentionBots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          color: bot.color,
        })),
        groups: mentionGroups.map((group) => ({
          id: group.id,
          name: group.name,
        })),
        routines: mentionRoutines.map((routine) => ({
          id: routine.id,
          name: routine.name,
          crons: routine.crons,
          botId: routine.botId,
          botName: routine.botName,
        })),
        connectors: mentionConnectors,
      }),
    [groupId, inGroup, mentionBots, mentionConnectors, mentionGroups, mentionRoutines],
  );
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || composerMentionTargets.length === 0) return [];
    const query = mentionQuery.trim().toLowerCase();
    return composerMentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [composerMentionTargets, mentionQuery]);
  const slashQueryNormalized = slashQuery?.trim().toLowerCase() ?? null;
  const slashSkillOptions =
    slashQuery !== null && mentionQuery === null
      ? agentSkills
          .filter((skill) => {
            if (!slashQueryNormalized) return true;
            return (
              skill.name.toLowerCase().includes(slashQueryNormalized) ||
              skill.description.toLowerCase().includes(slashQueryNormalized)
            );
          })
          .slice(0, 8)
      : [];
  const slashActionOptions =
    slashQuery !== null && mentionQuery === null
      ? SLASH_ACTIONS.filter((action) => {
          if (!slashQueryNormalized) return true;
          const label = t(action.label);
          return (
            action.label.toLowerCase().includes(slashQueryNormalized) ||
            label.toLowerCase().includes(slashQueryNormalized)
          );
        })
      : [];
  const currentBot = botId ? mentionBots.find((bot) => bot.id === botId) : undefined;
  const displayName = currentBot?.name ?? name;
  const notificationThreadId = snap?.threadId ?? currentBot?.threadId;
  activeThreadId.current = notificationThreadId;
  const currentBotStatus = snap ? snap.run?.status : currentBot?.status;
  const hasLiveProgress = visibleMessages.some((message) => message.id.startsWith("progress:"));
  // One bot only: an activity line names one bot's tool, so it would mislabel a group.
  const activityLabel = latestActivityLabel(snap?.messages ?? []);
  // The runs a working line speaks for, and the source of its clock.
  const workingRuns = useMemo(() => {
    const runs = snap?.activeRuns ?? (snap?.run ? [snap.run] : []);
    return runs.filter((run) => isWorkingStatus(run.status));
  }, [snap?.activeRuns, snap?.run]);
  const workingGroupBots = useMemo(() => {
    if (!inGroup) return [];
    const seen = new Set<string>();
    return workingRuns.flatMap((run) => {
      if (!run.botId || seen.has(run.botId)) return [];
      const member = snap?.members?.find((candidate) => candidate.botId === run.botId);
      if (!member) return [];
      seen.add(run.botId);
      return [{ ...member, status: run.status }];
    });
  }, [inGroup, snap?.members, workingRuns]);
  const working = inGroup ? workingGroupBots.length > 0 : isWorkingStatus(currentBotStatus);

  useEffect(() => {
    void rpc<AgentSkillCatalogEntry[]>("agentSkills/list")
      .then(setAgentSkills)
      .catch(() => setAgentSkills([]));
  }, []);

  useEffect(() => {
    setThreadScrollState(scrollBehavior.current.state());
  }, [threadKey]);

  const refreshMentionBots = useCallback(async () => {
    if (!botId && !groupId) return;
    const generation = ++mentionBotsRefreshGeneration.current;
    const targetBotId = botId;
    try {
      const bots = await rpc<MobileBot[]>("bots/list");
      // Apply any successful response that is still the newest applied so far.
      // A later failed refresh must not discard an earlier success.
      if (generation < mentionBotsAppliedGeneration.current) return;
      if (targetBotId !== activeBotId.current) return;
      mentionBotsAppliedGeneration.current = generation;
      setMentionBots(bots);
      if (targetBotId) {
        const next = bots.find((bot) => bot.id === targetBotId);
        // Read the route name from a ref so renaming does not recreate this
        // callback (and restart the SSE subscription that depends on it).
        if (next?.name && next.name !== routeName.current) {
          router.setParams({ name: next.name });
        }
      }
    } catch {
      // Keep the last known roster if refresh fails.
    }
  }, [botId, groupId, router]);

  useEffect(() => {
    void refreshMentionBots();
    void rpc<MobileGroup[]>("groups/list")
      .then(setMentionGroups)
      .catch(() => setMentionGroups([]));
  }, [refreshMentionBots]);

  useEffect(() => {
    if (mentionBots.length === 0) {
      setMentionRoutines([]);
      setMentionConnectors([]);
      return;
    }
    let cancelled = false;
    const botNameById = new Map(mentionBots.map((bot) => [bot.id, bot.name]));
    void Promise.all(
      mentionBots.map((bot) =>
        rpc<Routine[]>("routines/list", { botId: bot.id })
          .then((rows) =>
            rows.map((routine) => ({
              ...routine,
              botName: botNameById.get(bot.id) ?? bot.name,
            })),
          )
          .catch(() => [] as Array<Routine & { botName?: string }>),
      ),
    ).then((lists) => {
      if (!cancelled) setMentionRoutines(lists.flat());
    });
    void Promise.all([
      rpc<Connection[]>("connections/list").catch(() => [] as Connection[]),
      rpc<ConnectionCatalogItem[]>("connections/catalog", {}).catch(
        () => [] as ConnectionCatalogItem[],
      ),
    ]).then(([connections, catalog]) => {
      if (cancelled) return;
      const connected = connections.filter((row) => row.status === "connected");
      const options: Array<{
        id: string;
        name: string;
        authStatus: "connected" | "needs_auth";
        connectionId?: string;
      }> = connected.map((row) => ({
        id: row.id,
        name: row.displayName,
        authStatus: "connected" as const,
        connectionId: row.id,
      }));
      for (const item of catalog) {
        if (item.connected || item.noAuth) continue;
        if (
          connected.some(
            (row) =>
              row.provider.toLowerCase() === item.slug.toLowerCase() ||
              row.displayName.toLowerCase() === item.name.toLowerCase(),
          )
        ) {
          continue;
        }
        options.push({
          id: `catalog:${item.connectorId}:${item.slug}`,
          name: item.name,
          authStatus: "needs_auth",
        });
      }
      setMentionConnectors(options);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionBots]);

  function isCurrentTarget(targetBotId: string | undefined, targetGroupId: string | undefined) {
    return activeBotId.current === targetBotId && activeGroupId.current === targetGroupId;
  }

  const workingBotIds = useMemo(
    () => new Set(workingGroupBots.flatMap((bot) => (bot.botId ? [bot.botId] : []))),
    [workingGroupBots],
  );
  const groupAvatarItems = useMemo(
    () =>
      (snap?.members ?? []).map((member) => ({
        color: member.color,
        identity: member.botId,
        shapeSeed: member.shapeSeed,
        working: workingBotIds.has(member.botId),
      })),
    [snap?.members, workingBotIds],
  );
  const groupMemberNames = useMemo(
    () => (snap?.members ?? []).map((member) => member.name).join(", "),
    [snap?.members],
  );

  // `showBotActions` closes over `botActions` (and `name`), which are rebuilt
  // every render; keeping only this ref out of the header effect's deps means
  // a long press always reads the latest bot-actions sheet without the
  // effect re-running (and reassigning `navigation.setOptions`) on renders
  // that don't otherwise change the header.
  const showBotActionsRef = useRef(showBotActions);
  showBotActionsRef.current = showBotActions;

  useLayoutEffect(() => {
    navigation.setOptions({
      title: displayName || t("Thread"),
      // Bot actions (chat settings, open computer, clear, archive, delete) now
      // live on a long press; a short press still opens chat settings.
      headerTitle: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={!inGroup && botId ? t("Chat settings") : displayName || t("Thread")}
          disabled={inGroup || !botId}
          onPress={() => {
            if (!botId || inGroup) return;
            router.push({ pathname: "/bot-settings", params: { botId } });
          }}
          onLongPress={!inGroup && botId ? () => showBotActionsRef.current() : undefined}
          style={{
            alignItems: "center",
            maxWidth: 240,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {!inGroup && currentBot ? (
              <BotAvatar
                color={currentBot.color}
                identity={currentBot.id}
                shapeSeed={currentBot.shapeSeed}
                size={34}
                status={currentBotStatus}
                muted={!currentBot.notifyOnFinish}
              />
            ) : null}
            <Text
              numberOfLines={1}
              style={{
                ...nativeTextStyle("title", { size: 17, weight: 600 }),
                color: tokens.foreground,
              }}
            >
              {displayName || t("Thread")}
            </Text>
          </View>
          {inGroup && groupAvatarItems.length > 0 ? (
            <View style={{ marginTop: 2 }}>
              <StackedAvatars
                items={groupAvatarItems}
                size={sizes.stackXs}
                label={groupMemberNames || undefined}
              />
            </View>
          ) : null}
        </Pressable>
      ),
      headerRight: () =>
        inGroup ? (
          <Pressable
            accessibilityLabel={t("Group settings")}
            hitSlop={8}
            onPress={() =>
              router.push({
                pathname: "/group-settings",
                params: { groupId: groupId ?? "" },
              })
            }
          >
            <NativeSymbol
              ios="gearshape"
              android="settings-outline"
              size={21}
              color={tokens.foreground}
            />
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel={t("Open computer")}
            hitSlop={8}
            onPress={() =>
              router.push({
                pathname: "/computer",
                params: { botId: botId ?? "", name: displayName ?? t("Bot") },
              })
            }
          >
            <NativeSymbol
              ios="desktopcomputer"
              android="desktop-outline"
              size={21}
              color={tokens.foreground}
            />
          </Pressable>
        ),
    });
  }, [
    botId,
    currentBot,
    currentBotStatus,
    displayName,
    groupAvatarItems,
    groupId,
    groupMemberNames,
    inGroup,
    navigation,
    router,
    t,
    tokens,
    colorScheme,
  ]);

  function leaveBot() {
    router.dismissAll();
    router.replace("/");
  }

  function clearConversation() {
    if (!botId) return;
    setError(null);
    void rpc("threads/clear", { botId })
      .then(() => {
        expandedHistoryThread.current = null;
        pinnedAroundRef.current = null;
        historyEpoch.current += 1;
        setSnap((current) =>
          current ? { ...current, messages: [], olderCursor: null, run: null } : current,
        );
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t("Could not clear conversation")),
      );
  }

  const botActions = [
    {
      text: t("Chat settings"),
      onPress: () =>
        router.push({
          pathname: "/bot-settings",
          params: { botId: botId ?? "" },
        }),
    },
    {
      text: t("Open computer"),
      onPress: () =>
        router.push({
          pathname: "/computer",
          params: { botId: botId ?? "", name: displayName ?? t("Bot") },
        }),
    },
    {
      text: t("Clear conversation"),
      destructive: true,
      onPress: () =>
        Alert.alert(
          t("Clear conversation?"),
          t(
            "This removes every message and stops current work. The bot, computer, memory, and routines are kept.",
          ),
          [
            { text: t("Cancel"), style: "cancel" },
            {
              text: t("Clear"),
              style: "destructive",
              onPress: clearConversation,
            },
          ],
        ),
    },
    {
      text: t("Archive"),
      onPress: () =>
        void rpc("bots/archive", { botId })
          .then(leaveBot)
          .catch((error) =>
            Alert.alert(
              t("Could not archive bot"),
              error instanceof Error ? error.message : t("Try again."),
            ),
          ),
    },
    {
      text: t("Delete…"),
      destructive: true,
      onPress: () => confirmDeleteBot({ id: botId ?? "", name: displayName || t("Bot") }, leaveBot),
    },
  ];

  function showBotActions() {
    if (!botId) return;
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: name || t("Bot"),
          userInterfaceStyle: colorScheme,
          options: [...botActions.map((action) => action.text), t("Cancel")],
          cancelButtonIndex: botActions.length,
          destructiveButtonIndex: botActions.flatMap((action, index) =>
            action.destructive ? [index] : [],
          ),
        },
        (index) => botActions[index]?.onPress(),
      );
      return;
    }
    setBotActionsOpen(true);
  }

  async function refresh() {
    if (!botId && !groupId) return;
    const targetBotId = botId;
    const targetGroupId = groupId;
    const epoch = historyEpoch.current;
    const next = await rpc<MobileSnapshot>(
      "threads/get",
      targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
    );
    if (
      !shouldApplyMobileThreadRefresh({
        requestEpoch: epoch,
        currentEpoch: historyEpoch.current,
        targetBotId,
        targetGroupId,
        activeBotId: activeBotId.current,
        activeGroupId: activeGroupId.current,
      })
    )
      return next;
    setSnap((prev) =>
      mergeMobileSnapshot(prev, next, expandedHistoryThread.current === next.threadId),
    );
    return next;
  }

  async function applyMessageJump(target: { botId?: string; groupId?: string; messageId: string }) {
    const threadTarget = target.groupId ? { groupId: target.groupId } : { botId: target.botId! };
    const epoch = historyEpoch.current;
    jumpGeneration.current += 1;
    const jumpId = jumpGeneration.current;
    const [snap, page] = await Promise.all([
      rpc<MobileSnapshot>("threads/get", threadTarget),
      rpc<MobileMessagePage>("threads/messages", {
        ...threadTarget,
        around: { messageId: target.messageId },
      }),
    ]);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch); the
    // generation check drops an older same-thread jump that finished after a newer one.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const targetInPage = page.messages.some((message) => message.id === target.messageId);
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? {
          ...threadTarget,
          messageId: target.messageId,
          threadId: page.threadId,
          messages: [...page.messages],
          olderCursor: page.olderCursor,
        }
      : null;
    jumpScrollTarget.current = targetInPage ? target.messageId : null;
    setSnap({
      ...snap,
      messages: targetInPage ? [...page.messages] : snap.messages,
      olderCursor: targetInPage ? page.olderCursor : snap.olderCursor,
    });
  }

  async function loadOlderMessages() {
    if ((!botId && !groupId) || snap?.olderCursor == null || loadingOlder) return;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    try {
      const page = await rpc<MobileMessagePage>("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        before: snap.olderCursor,
        includePeerReceipts: true,
      });
      if (epoch !== historyEpoch.current) {
        loadingOlderContent.current = false;
        return;
      }
      expandedHistoryThread.current = page.threadId;
      setSnap((prev) => prependMobileMessagePage(prev, page));
    } catch (err) {
      loadingOlderContent.current = false;
      setError(err instanceof Error ? err.message : t("Could not load earlier messages"));
    } finally {
      setLoadingOlder(false);
    }
  }

  const markReadIfVisible = useCallback(() => {
    if (AppState.currentState !== "active" || !navigation.isFocused()) return;
    const target = groupId ?? botId;
    if (!target || readVisibleTarget.current === target) return;
    readVisibleTarget.current = target;
    if (activeThreadId.current) {
      void dismissThreadNotifications({
        threadId: activeThreadId.current,
      }).catch(() => undefined);
    }
    if (groupId) {
      void rpc("threads/markRead", { groupId }).catch(() => {
        if (readVisibleTarget.current === target) readVisibleTarget.current = null;
      });
      return;
    }
    void rpc("threads/markRead", { botId: botId! }).catch(() => {
      if (readVisibleTarget.current === target) readVisibleTarget.current = null;
    });
  }, [botId, groupId, navigation]);

  useEffect(() => {
    if (!notificationThreadId || AppState.currentState !== "active" || !navigation.isFocused())
      return;
    void setOpenNotificationThread({
      botId,
      threadId: notificationThreadId,
    }).catch(() => undefined);
    void dismissThreadNotifications({ threadId: notificationThreadId }).catch(() => undefined);
  }, [botId, navigation, notificationThreadId]);

  // Cancel delayed setup only when leaving this bot's thread (unmount or botId
  // change). Blur alone is not leave — settings/computer push must keep the timer.
  useEffect(() => {
    if (!botId) return;
    return () => {
      cancelFocusPrompt(botId);
    };
  }, [botId]);

  // Covers returning from a pushed screen; the AppState listener covers returning from background.
  useFocusEffect(
    useCallback(() => {
      if (botId) {
        focusPromptThreadActive(botId);
        void saveLastBotId(botId).catch(() => undefined);
      } else {
        // Group thread focus: prior bot screen may stay mounted, so clear any delayed setup.
        cancelFocusPrompt();
      }
      if (AppState.currentState === "active" && notificationThreadId) {
        void setOpenNotificationThread({
          botId,
          threadId: notificationThreadId,
        }).catch(() => undefined);
      }
      void refreshMentionBots();
      markReadIfVisible();
      return () => {
        void setOpenNotificationThread(null).catch(() => undefined);
      };
    }, [botId, markReadIfVisible, notificationThreadId, refreshMentionBots]),
  );

  useEffect(() => {
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        if (!navigation.isFocused() || !notificationThreadId) return;
        void setOpenNotificationThread({
          botId,
          threadId: notificationThreadId,
        }).catch(() => undefined);
        markReadIfVisible();
        return;
      }
      void setOpenNotificationThread(null).catch(() => undefined);
    });
    return () => appState.remove();
  }, [botId, markReadIfVisible, navigation, notificationThreadId]);

  useEffect(() => {
    if (!botId && !groupId) return;
    if (!messageId) {
      pinnedAroundRef.current = null;
      jumpScrollTarget.current = null;
    }
    expandedHistoryThread.current = null;
    historyEpoch.current += 1;
    const abort = new AbortController();
    void (async () => {
      // Pending search jumps load the around-page separately; avoid replacing it with latest.
      const next = messageId
        ? await rpc<MobileSnapshot>("threads/get", groupId ? { groupId } : { botId: botId! }).catch(
            (err: Error) => {
              setError(err.message);
              return null;
            },
          )
        : await refresh().catch((err: Error) => {
            setError(err.message);
            return null;
          });
      if (abort.signal.aborted) return;
      let cursor = next?.cursor ?? -1;
      let retryMs = 250;
      while (!abort.signal.aborted) {
        try {
          await subscribeThread(
            groupId ? { groupId } : { botId: botId! },
            cursor,
            (event) => {
              cursor = Math.max(cursor, event.seq ?? -1);
              retryMs = 250;
              if (
                event.type === "thread.progress" ||
                event.type === "agent.tool.called" ||
                event.type === "agent.tool.completed" ||
                event.type === "thread.message.created" ||
                event.type === "thread.message.updated" ||
                event.type === "thread.subagent" ||
                event.type === "thread.cloud_agent" ||
                event.type === "thread.cleared" ||
                event.type === "thread.rewound" ||
                event.type === "run.waiting_input" ||
                event.type === "computer.takeover.requested" ||
                isRunTerminalEvent(event)
              ) {
                if (event.type === "thread.cleared") {
                  expandedHistoryThread.current = null;
                  pinnedAroundRef.current = null;
                  historyEpoch.current += 1;
                }
                setSnap((prev) => applyMobileThreadEvent(prev, event));
              }
              if (event.type === "bot.updated") {
                void refreshMentionBots();
              }
              if (event.type === "thread.message.created" && event.payload?.role === "bot") {
                readVisibleTarget.current = null;
                markReadIfVisible();
              }
              if (isRunTerminalEvent(event)) {
                void refreshMentionBots();
                if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
                  void refresh().catch(() => undefined);
                }
              }
            },
            abort.signal,
          );
        } catch {
          // A full refresh reconciles visible state; the event cursor still resumes without gaps.
        }
        if (abort.signal.aborted) break;
        if (!jumpScrollTarget.current && !expandedHistoryThread.current) {
          await refresh().catch(() => undefined);
        }
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    })();
    return () => {
      abort.abort();
    };
  }, [botId, groupId, markReadIfVisible, refreshMentionBots]);

  useEffect(() => {
    if (!botId && !groupId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (
        AppState.currentState === "active" &&
        navigation.isFocused() &&
        !jumpScrollTarget.current &&
        !expandedHistoryThread.current
      ) {
        await refresh().catch(() => undefined);
      }
      if (!cancelled) {
        timer = setTimeout(() => void tick(), threadRefreshDelayMs(snap?.run?.status));
      }
    };
    timer = setTimeout(() => void tick(), threadRefreshDelayMs(snap?.run?.status));
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [botId, groupId, navigation, snap?.run?.status]);

  useEffect(() => {
    if ((!botId && !groupId) || !messageId) return;
    void applyMessageJump(groupId ? { groupId, messageId } : { botId: botId!, messageId }).catch(
      (err) => {
        setError(err instanceof Error ? err.message : t("Could not open message"));
      },
    );
  }, [botId, groupId, messageId]);

  useEffect(() => {
    setPendingAttachments((current) => attachmentsForThread(current, threadKey));
    setDraft("");
    setMentionQuery(null);
    setSlashQuery(null);
    setSelectedSkill(null);
    setSelectedMentions([]);
    setReplyTarget(null);
    setRewindTarget(null);
    setRewindArtifactIds([]);
    setAttachmentNotice(null);
    setError(null);
  }, [threadKey]);

  function cancelRewind() {
    setRewindTarget(null);
    setRewindArtifactIds([]);
  }

  function startRewind(message: MobileMessage) {
    setReplyTarget(null);
    setRewindTarget(message);
    setRewindArtifactIds(
      message.blocks.flatMap((block) =>
        block.kind === "image" || block.kind === "file" ? [block.artifactId] : [],
      ),
    );
    setDraft(
      message.blocks
        .flatMap((block) => (block.kind === "text" && block.text ? [block.text] : []))
        .join("\n"),
    );
  }

  function updateDraft(value: string) {
    setDraft(value);
    const match = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(match ? (match[1] ?? "") : null);
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    setSlashQuery(slashMatch ? (slashMatch[1] ?? "") : null);
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) => current.replace(/@([\w-]*)$/, ""));
    setMentionQuery(null);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  function serializeComposerPromptText(): string {
    return serializeComposerPrompt(draft, selectedSkill, selectedMentions);
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
    setSlashQuery(null);
    if (action === "chat-settings") {
      if (inGroup && groupId) {
        router.push({ pathname: "/group-settings", params: { groupId } });
      } else if (botId) {
        router.push({ pathname: "/bot-settings", params: { botId } });
      }
      return;
    }
    router.push({
      pathname: "/account",
      params: action === "settings-usage" ? { focus: "usage" } : undefined,
    });
  }

  const canSend =
    Boolean(draft.trim()) ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    activePendingAttachments.length > 0;

  async function send() {
    const initialBotTarget = botId;
    const initialGroupTarget = groupId;
    if ((!initialBotTarget && !initialGroupTarget) || sending) return;
    const originThreadKey = initialGroupTarget ?? initialBotTarget;
    const attachments = attachmentsForThread(pendingAttachments, originThreadKey);
    const plan = resolveComposerSendPlan({
      text: serializeComposerPromptText(),
      mentions: selectedMentions,
      hasAttachments: attachments.length > 0 || rewindArtifactIds.length > 0,
    });
    if (plan.isNoOp) return;
    const reroutedToGroup = Boolean(
      plan.rerouteGroupId && plan.rerouteGroupId !== initialGroupTarget,
    );
    const groupTarget = plan.rerouteGroupId ?? initialGroupTarget;
    const botTarget = reroutedToGroup ? undefined : initialBotTarget;
    const trimmed = plan.trimmed;
    const dropDelayedSetup = () => {
      // Only after successful engagement so a failed upload/send keeps the setup card.
      // Covers group-mention reroute while the bot thread stays mounted underneath.
      if (initialBotTarget) cancelFocusPrompt(initialBotTarget);
    };
    setSending(true);
    setError(null);
    try {
      if (plan.shouldRunRoutines) {
        const sendNonce = newClientNonce();
        await Promise.all(
          plan.routineIds.map((routineId) =>
            rpc("routines/testRun", {
              routineId,
              clientNonce: `routine-mention:${sendNonce}:${routineId}`,
            }),
          ),
        );
      }
      const clearOriginComposer = () => {
        setPendingAttachments((current) =>
          current.filter((attachment) => attachment.threadKey !== originThreadKey),
        );
        setDraft("");
        setMentionQuery(null);
        setSlashQuery(null);
        setSelectedSkill(null);
        setSelectedMentions([]);
        setReplyTarget(null);
        setRewindTarget(null);
        setRewindArtifactIds([]);
        setAttachmentNotice(null);
      };
      if (!plan.shouldSend) {
        dropDelayedSetup();
        clearOriginComposer();
        if (reroutedToGroup && groupTarget) {
          router.push({
            pathname: "/group-thread",
            params: {
              groupId: groupTarget,
              name: plan.rerouteGroupName ?? t("Group"),
            },
          });
          return;
        }
        if (isCurrentTarget(botTarget, groupTarget)) {
          await refresh();
        }
        return;
      }
      const artifactIds: string[] = rewindTarget ? [...rewindArtifactIds] : [];
      for (const pending of attachments) {
        const artifact = await rpc<{ id: string }>("artifacts/create", {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          name: pending.name,
          mimeType: pending.mimeType,
          contentBase64: pending.contentBase64,
        });
        artifactIds.push(artifact.id);
      }
      // Truncation happens here rather than on Edit, so backing out costs nothing.
      if (rewindTarget && !reroutedToGroup) {
        await rpc("threads/rewind", {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          messageId: rewindTarget.id,
        });
      }
      const clientNonce = newClientNonce();
      await rpc(
        "threads/send",
        groupTarget
          ? {
              groupId: groupTarget,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: reroutedToGroup ? undefined : replyTarget?.id,
            }
          : {
              botId: botTarget!,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: replyTarget?.id,
            },
      );
      dropDelayedSetup();
      void loadSessionToken()
        .then((token) => resumeLiveNotifications(currentApiBase(), token, selectedSpaceId() ?? ""))
        .catch(() => undefined);
      clearOriginComposer();
      if (reroutedToGroup && groupTarget) {
        router.push({
          pathname: "/group-thread",
          params: {
            groupId: groupTarget,
            name: plan.rerouteGroupName ?? t("Group"),
          },
        });
        return;
      }
      if (isCurrentTarget(botTarget, groupTarget)) {
        await refresh();
      }
    } catch (err) {
      if (reroutedToGroup && groupTarget) {
        setError(err instanceof Error ? err.message : t("Failed to send message"));
      } else if (isCurrentTarget(botTarget, groupTarget)) {
        setError(err instanceof Error ? err.message : t("Failed to send message"));
      }
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if ((!targetBotId && !targetGroupId) || sending) return;
    setSending(true);
    setError(null);
    try {
      await rpc(
        "threads/stop",
        targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
      );
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        setError(err instanceof Error ? err.message : t("Failed to stop work"));
      }
      setSending(false);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      if (isCurrentTarget(targetBotId, targetGroupId)) {
        const detail = err instanceof Error ? err.message : t("Failed to refresh");
        setError(t("Work stopped, but the thread could not refresh: {detail}", { detail }));
      }
    } finally {
      setSending(false);
    }
  }

  const answerMessage = useCallback(
    async (message: MobileMessage, answer: string) => {
      const targetBotId = botId;
      const targetGroupId = groupId;
      if ((!targetBotId && !targetGroupId) || !message.runId) return;
      await rpc("threads/answer", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        runId: message.runId,
        messageId: message.id,
        answer,
      });
      if (isCurrentTarget(targetBotId, targetGroupId)) await refresh();
    },
    [botId, groupId],
  );

  const openBot = useCallback(
    (id: string, botName: string) =>
      router.push({
        pathname: "/thread",
        params: { botId: id, name: botName },
      }),
    [router],
  );

  const speak = useCallback(
    (message: MobileMessage) =>
      void speakMessage(message.botId ?? botId ?? snap?.members?.[0]?.botId ?? "", message).catch(
        (err) =>
          Alert.alert(t("Could not speak"), err instanceof Error ? err.message : t("Try again.")),
      ),
    [botId, snap?.members],
  );

  function showAttachMenu() {
    Alert.alert(t("Attach"), undefined, [
      {
        text: t("Photo library"),
        onPress: () => void addAttachments(pickFromLibrary),
      },
      { text: t("Camera"), onPress: () => void addAttachments(takePhoto) },
      { text: t("File"), onPress: () => void addAttachments(pickDocuments) },
      { text: t("Cancel"), style: "cancel" },
    ]);
  }

  async function addAttachments(
    picker: (existingCount: number) => Promise<{
      attachments: PickedAttachment[];
      skipped: Array<{ name: string; reason: string }>;
    }>,
  ) {
    const targetKey = groupId ?? botId;
    if (!targetKey) return;
    const result = await picker(activePendingAttachments.length);
    if ((groupId ?? botId) !== targetKey) return;
    if (result.attachments.length) {
      setPendingAttachments((current) => [
        ...current,
        ...result.attachments.map((attachment) => ({
          ...attachment,
          threadKey: targetKey,
        })),
      ]);
    }
    setAttachmentNotice(
      result.skipped.length
        ? t("Skipped {items}", {
            items: result.skipped.map((item) => formatAttachmentSkip(item)).join(", "),
          })
        : null,
    );
  }

  const answerableAskMessageId = latestAnswerableAskMessageId(snap);
  const runError = snap?.run?.status === "failed" ? (snap.run.error ?? null) : null;
  const liveMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  const messagesById = useMemo(
    () => new Map((snap?.messages ?? []).map((message) => [message.id, message])),
    [snap?.messages],
  );
  const pinnedTarget = pinnedAroundRef.current;
  const showPinnedPage = Boolean(
    jumpScrollTarget.current ||
      (pinnedTarget &&
        ((pinnedTarget.botId && pinnedTarget.botId === botId) ||
          (pinnedTarget.groupId && pinnedTarget.groupId === groupId))),
  );

  function performScroll(action: ThreadScrollAction) {
    if (!action || showPinnedPage) return;
    scroll.current?.scrollToOffset({
      offset: 0,
      animated: action === "smooth" && !reducedMotion,
    });
  }

  function updateUserScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    // Inverted FlatList: contentOffset.y is distance from the latest messages.
    setThreadScrollState(
      scrollBehavior.current.onUserScroll(Math.max(0, event.nativeEvent.contentOffset.y)),
    );
  }

  async function reactToMessage(message: MobileMessage, reaction: MessageReaction) {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if (!targetBotId && !targetGroupId) return;
    try {
      await rpc("threads/react", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        messageId: message.id,
        reaction,
        clientNonce: newClientNonce(),
      });
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return;
      setError(err instanceof Error ? err.message : t("Could not update reaction"));
    }
  }

  function messageActionProps(message: MobileMessage): MessageActionProps {
    const actions = [
      {
        name: "reply",
        text: t("Reply"),
        onPress: () => setReplyTarget(message),
      },
      ...(canReactToThreadMessage(message)
        ? [
            {
              name: "react",
              text: t("React"),
              onPress: () =>
                presentMessageActionSheet({
                  cancel: t("Cancel"),
                  more: t("More"),
                  colorScheme,
                  actions: MESSAGE_REACTIONS.map((emoji) => ({
                    name: emoji,
                    text: emoji,
                    onPress: () => void reactToMessage(message, emoji),
                  })),
                }),
            },
          ]
        : []),
      ...(message.role === "user"
        ? [
            {
              name: "rewind",
              text: "Edit and resend",
              onPress: () => startRewind(message),
            },
          ]
        : []),
      ...(message.role === "bot" && blockText(message)
        ? [
            {
              name: "speak",
              text: t("Speak message"),
              onPress: () => void speak(message),
            },
          ]
        : []),
      {
        name: "copy",
        text: t("Copy"),
        onPress: () => {
          const text = copyableMobileMessageText(message);
          if (text) void Clipboard.setStringAsync(text).catch(() => undefined);
        },
      },
    ];
    return {
      onLongPress: () =>
        presentMessageActionSheet({
          actions,
          title: message.createdAt ? messageClockTime(message.createdAt) : undefined,
          cancel: t("Cancel"),
          more: t("More"),
          colorScheme,
        }),
      accessibilityActions: actions.map((action) => ({ name: action.name, label: action.text })),
      onAccessibilityAction: (event) => {
        actions.find((action) => action.name === event.nativeEvent.actionName)?.onPress();
      },
    };
  }

  /** Colour, name and shape of the bot behind a message: the group roster
   * first, the bot list second, the route name last. */
  function messageBot(id: string | undefined) {
    const member = snap?.members?.find((candidate) => candidate.botId === id);
    const bot = mentionBots.find((candidate) => candidate.id === id);
    return {
      color: member?.color ?? bot?.color ?? tokens.mutedForeground,
      name: member?.name ?? bot?.name ?? displayName ?? t("Bot"),
      shapeSeed: member?.shapeSeed ?? bot?.shapeSeed,
    };
  }

  function renderMessageRow(
    message: MobileMessage,
    options?: { enableJump?: boolean; previousCreatedAt?: string },
  ) {
    const actionProps = messageActionProps(message);
    const createdAt = message.createdAt;
    const timeMarker =
      createdAt && showsTimeMarker(options?.previousCreatedAt, createdAt)
        ? threadTimeMarkerLabel(createdAt, {
            locale: dateLocaleForUi(),
            today: t("Today"),
            yesterday: t("Yesterday"),
          })
        : "";
    const messageReactions = reactionView.reactions.get(message.id);
    const drawnBlocks = visibleMessageBlocks(message.blocks, showSteps);
    // An aside is a note between messages and carries no author; a bot's
    // question or approval is a normal row, its FramedBlock card just the
    // row's body. Aside is decided by the blocks alone (a peer receipt is
    // stored with role "user" but is still an aside).
    const chrome: MessageChrome = isAsideOnlyMessage(drawnBlocks) ? "aside" : "row";
    const authorBotId = message.botId ?? botId;
    const author = messageBot(authorBotId);
    const authorStatus = message.id.startsWith("progress:")
      ? (snap?.activeRuns?.find((run) => run.botId === authorBotId)?.status ??
        (snap?.run?.botId === authorBotId ? snap?.run?.status : currentBotStatus))
      : undefined;
    const bubble = (
      <MessageBubble
        botId={botId ?? snap?.members?.[0]?.botId ?? ""}
        groupId={groupId}
        message={message}
        botName={displayName}
        bots={mentionBots}
        members={snap?.members}
        replyPreview={
          chrome === "row" && message.replyToMessageId
            ? messagesById.get(message.replyToMessageId)
            : undefined
        }
        canAnswer={message.id === answerableAskMessageId}
        onAnswer={answerMessage}
        onOpenBot={openBot}
        onPreviewMarkdown={setMarkdownPreview}
        actionProps={actionProps}
      />
    );
    return (
      <View
        key={message.id}
        onLayout={
          options?.enableJump
            ? (event) => {
                if (jumpScrollTarget.current !== message.id) return;
                const y = Math.max(0, event.nativeEvent.layout.y - 24);
                requestAnimationFrame(() => {
                  if (jumpScrollTarget.current !== message.id) return;
                  pinnedScroll.current?.scrollTo({ y, animated: true });
                  jumpScrollTarget.current = null;
                });
              }
            : undefined
        }
        style={{ marginTop: chrome === "aside" ? ASIDE_GAP : MESSAGE_GAP }}
      >
        {timeMarker ? (
          <Text
            style={{
              alignSelf: "center",
              marginBottom: MESSAGE_GAP,
              color: tokens.mutedForeground,
              ...nativeTextStyle("label"),
            }}
          >
            {timeMarker}
          </Text>
        ) : null}
        <View
          style={{
            opacity: rewindTarget && (message.seq ?? 0) >= (rewindTarget.seq ?? 0) ? 0.4 : 1,
          }}
        >
          {chrome === "row" && message.role === "bot" ? (
            <MessageRow
              avatar={
                <BotAvatar
                  color={author.color}
                  identity={authorBotId}
                  shapeSeed={author.shapeSeed}
                  size={sizes.message}
                  status={authorStatus}
                />
              }
              author={author.name}
              time={createdAt ? messageClockTime(createdAt) : undefined}
            >
              <Pressable accessible={false} onLongPress={actionProps.onLongPress}>
                {bubble}
              </Pressable>
            </MessageRow>
          ) : chrome === "row" ? (
            <Pressable accessible={false} onLongPress={actionProps.onLongPress}>
              {bubble}
            </Pressable>
          ) : (
            <View>{bubble}</View>
          )}
          {messageReactions ? (
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 4,
                marginTop: 6,
                marginStart: chrome === "row" && message.role === "bot" ? FRAMED_INDENT : 0,
                justifyContent: message.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              {[...messageReactions].map(([emoji, count]) => (
                <Text
                  key={emoji}
                  style={{
                    color: tokens.foreground,
                    backgroundColor: tokens.muted,
                    borderColor: tokens.border,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderRadius: radii.pill,
                    paddingHorizontal: 8,
                    paddingVertical: 2,
                    ...nativeTextStyle("meta"),
                  }}
                >
                  {emoji}
                  {count > 1 ? ` ${count}` : ""}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  const workingBotsForLine = inGroup
    ? workingGroupBots
    : currentBot && isWorkingStatus(currentBotStatus) && !hasLiveProgress
      ? [
          {
            botId: currentBot.id,
            name: currentBot.name,
            color: currentBot.color,
            shapeSeed: currentBot.shapeSeed,
            status: currentBotStatus,
          },
        ]
      : [];
  // One bot only: an activity line names one bot's tool, so it would mislabel a group.
  const workingLabel =
    (workingBotsForLine.length === 1 ? activityLabel : undefined) ??
    `${
      workingBotsForLine.length === 1
        ? t("{name} is working", { name: workingBotsForLine[0]?.name ?? t("Agent") })
        : t("{count} agents working", { count: workingBotsForLine.length })
    }…`;
  // The clock reads from when the run began, not from when this screen
  // mounted, so reopening a thread does not restart it at zero.
  const workingStartedAt = earliestRunStartMs(workingRuns);
  // The one thing that keeps moving during a run; everything else is still.
  const workingFooter = workingBotsForLine.length ? (
    <View style={{ marginTop: MESSAGE_GAP }}>
      <WorkingLine
        avatar={<GroupAvatar members={workingBotsForLine} size={sizes.message} />}
        label={workingLabel}
        startedAt={workingStartedAt}
      />
    </View>
  ) : null;

  const loadEarlierControl =
    snap?.olderCursor != null ? (
      <Pressable
        disabled={loadingOlder}
        onPress={() => void loadOlderMessages()}
        style={{
          alignSelf: "center",
          paddingHorizontal: 12,
          paddingVertical: 10,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
          {loadingOlder ? t("Loading…") : t("Load earlier messages")}
        </Text>
      </Pressable>
    ) : null;

  return (
    <KeyboardAvoidingView
      behavior="height"
      keyboardVerticalOffset={headerHeight}
      style={{
        flex: 1,
        backgroundColor: tokens.background,
        paddingHorizontal: 20,
      }}
    >
      {error ? <Text style={{ color: tokens.mutedForeground, marginTop: 12 }}>{error}</Text> : null}
      {runError ? (
        <Text style={{ color: tokens.destructive, marginTop: 12 }}>{runError}</Text>
      ) : null}
      <View style={{ flex: 1, position: "relative" }}>
        {showPinnedPage ? (
          <ScrollView
            key={jumpScrollTarget.current ?? pinnedTarget?.messageId ?? threadKey}
            ref={pinnedScroll}
            style={{ flex: 1, marginTop: 8 }}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          >
            {loadEarlierControl}
            {visibleMessages.map((message, index) =>
              renderMessageRow(message, {
                enableJump: true,
                previousCreatedAt: visibleMessages[index - 1]?.createdAt,
              }),
            )}
            {workingFooter}
          </ScrollView>
        ) : (
          <FlatList
            key={threadKey}
            ref={scroll}
            data={liveMessages}
            inverted
            keyExtractor={(message) => message.id}
            extraData={answerableAskMessageId}
            style={{ flex: 1, marginTop: 8 }}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            scrollEventThrottle={16}
            onScrollBeginDrag={() => {
              userDragging.current = true;
            }}
            onScroll={(event) => {
              if (userDragging.current) updateUserScroll(event);
            }}
            onScrollEndDrag={(event) => {
              updateUserScroll(event);
              userDragging.current = false;
            }}
            onMomentumScrollEnd={updateUserScroll}
            onLayout={() => performScroll(scrollBehavior.current.onLayout())}
            onContentSizeChange={() => {
              if (loadingOlderContent.current) {
                loadingOlderContent.current = false;
                return;
              }
              const blocked = Boolean(
                jumpScrollTarget.current ||
                  (pinnedAroundRef.current &&
                    ((pinnedAroundRef.current.botId && pinnedAroundRef.current.botId === botId) ||
                      (pinnedAroundRef.current.groupId &&
                        pinnedAroundRef.current.groupId === groupId))) ||
                  expandedHistoryThread.current === snap?.threadId,
              );
              performScroll(scrollBehavior.current.onContentChanged(blocked, latestMessageId));
              setThreadScrollState(scrollBehavior.current.state());
            }}
            ListFooterComponent={loadEarlierControl}
            ListHeaderComponent={workingFooter}
            renderItem={({ item, index }) =>
              renderMessageRow(item, { previousCreatedAt: liveMessages[index + 1]?.createdAt })
            }
          />
        )}
        {!showPinnedPage && threadScrollState.detached ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              threadScrollState.unread ? t("Jump to latest, new messages") : t("Jump to latest")
            }
            onPress={() => {
              performScroll(scrollBehavior.current.jumpToLatest());
              setThreadScrollState(scrollBehavior.current.state());
            }}
            style={{
              position: "absolute",
              left: "50%",
              marginLeft: -21,
              bottom: 12,
              width: 42,
              height: 42,
              borderRadius: 21,
              borderWidth: 1,
              borderColor: native.fillPressed,
              backgroundColor: native.fill,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <NativeSymbol
              ios="arrow.down"
              android="arrow-down"
              size={18}
              color={tokens.foreground}
            />
            {threadScrollState.unread ? (
              <View
                style={{
                  position: "absolute",
                  top: 3,
                  right: 3,
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: tokens.primary,
                }}
              />
            ) : null}
          </Pressable>
        ) : null}
      </View>
      <View
        style={{
          // Keyboard covers the nav bar / home indicator, so the safe-area
          // inset would render as dead space between composer and keyboard.
          paddingBottom: keyboardVisible ? 12 : Math.max(insets.bottom + 12, 24),
        }}
      >
        {replyTarget ? (
          <View
            style={{
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.card,
              paddingHorizontal: 12,
              paddingVertical: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>
                {t("Replying to")}
              </Text>
              <Text style={{ color: tokens.foreground, fontSize: 13 }} numberOfLines={1}>
                {previewMessageText(replyTarget)}
              </Text>
            </View>
            <Pressable accessibilityLabel={t("Cancel reply")} onPress={() => setReplyTarget(null)}>
              <Text style={{ color: tokens.mutedForeground }}>✕</Text>
            </Pressable>
          </View>
        ) : null}
        {rewindTarget ? (
          <View
            style={{
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.sidebar,
              paddingHorizontal: 12,
              paddingVertical: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Text
              style={{ color: tokens.mutedForeground, fontSize: 12, flex: 1 }}
              numberOfLines={2}
            >
              {`Editing message · ${rewindRemovedCount} messages after it will be removed`}
            </Text>
            <Pressable accessibilityLabel="Cancel edit" onPress={cancelRewind}>
              <Text style={{ color: tokens.mutedForeground }}>✕</Text>
            </Pressable>
          </View>
        ) : null}
        {attachmentNotice ? (
          <Text style={{ color: tokens.warning, marginTop: 12, fontSize: 13 }}>
            {attachmentNotice}
          </Text>
        ) : null}
        {activePendingAttachments.length ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 12,
            }}
          >
            {activePendingAttachments.map((attachment) => (
              <View
                key={attachment.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: tokens.border,
                  backgroundColor: tokens.card,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                }}
              >
                {attachment.previewUri ? (
                  <Image
                    source={{ uri: attachment.previewUri }}
                    style={{ width: 28, height: 28, borderRadius: 6 }}
                  />
                ) : (
                  <Text style={{ color: tokens.foreground }}>📎</Text>
                )}
                <Text style={{ color: tokens.foreground, maxWidth: 140 }} numberOfLines={1}>
                  {attachment.name}
                </Text>
                <Pressable
                  accessibilityLabel={t("Remove {name}", {
                    name: attachment.name,
                  })}
                  onPress={() =>
                    setPendingAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    )
                  }
                >
                  <NativeSymbol
                    ios="xmark"
                    android="close"
                    size={14}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {mentionOptions.length ? (
          <View
            testID="mention-picker"
            style={{
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.card,
              overflow: "hidden",
            }}
          >
            {mentionOptions.map((mention) => (
              <Pressable
                key={mentionChipKey(mention)}
                accessibilityLabel={t("@{name}", { name: mention.name })}
                onPress={() => insertMention(mention)}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <MentionOptionIcon mention={mention} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 14 }}>@{mention.name}</Text>
                  {mention.subtitle ? (
                    <Text
                      numberOfLines={1}
                      style={{
                        color: tokens.mutedForeground,
                        fontSize: 12.5,
                        marginTop: 2,
                      }}
                    >
                      {mention.subtitle}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}
        {slashSkillOptions.length || slashActionOptions.length ? (
          <View
            testID="slash-picker"
            style={{
              marginTop: 12,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.card,
              overflow: "hidden",
            }}
          >
            {slashSkillOptions.map((skill) => (
              <Pressable
                key={skill.id}
                accessibilityLabel={t("Skill {name}", { name: skill.name })}
                onPress={() => insertSkill(skill)}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <NativeSymbol
                  ios="cube"
                  android="cube-outline"
                  size={16}
                  color={tokens.mutedForeground}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: tokens.foreground, fontSize: 14 }}>{skill.name}</Text>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: tokens.mutedForeground,
                      fontSize: 12.5,
                      marginTop: 2,
                    }}
                  >
                    {truncateSlashDescription(skill.description)}
                  </Text>
                </View>
              </Pressable>
            ))}
            {slashActionOptions.map((action) => (
              <Pressable
                key={action.id}
                accessibilityLabel={t(action.label)}
                onPress={() => runSlashAction(action.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                }}
              >
                <NativeSymbol
                  ios="gearshape"
                  android="settings-outline"
                  size={16}
                  color={tokens.mutedForeground}
                />
                <Text style={{ color: tokens.foreground, fontSize: 14 }}>{t(action.label)}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={{ marginTop: 16 }}>
          <ComposerShell
            leading={
              selectedSkill || selectedMentions.length > 0 ? (
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 1,
                    maxWidth: "60%",
                  }}
                >
                  {selectedSkill ? (
                    <View
                      testID="skill-chip"
                      style={[composerChip, { backgroundColor: tokens.accent }]}
                    >
                      <NativeSymbol
                        ios="cube"
                        android="cube-outline"
                        size={14}
                        color={tokens.mutedForeground}
                      />
                      <Text
                        numberOfLines={1}
                        style={{
                          color: tokens.foreground,
                          flexShrink: 1,
                          ...nativeTextStyle("capsule"),
                        }}
                      >
                        {selectedSkill.name}
                      </Text>
                      <Pressable
                        accessibilityLabel={t("Remove skill {name}", {
                          name: selectedSkill.name,
                        })}
                        hitSlop={8}
                        onPress={() => setSelectedSkill(null)}
                      >
                        <NativeSymbol
                          ios="xmark"
                          android="close"
                          size={12}
                          color={tokens.mutedForeground}
                        />
                      </Pressable>
                    </View>
                  ) : null}
                  {selectedMentions.map((mention) => (
                    <View
                      key={mentionChipKey(mention)}
                      testID="mention-chip"
                      style={[composerChip, { backgroundColor: tokens.chatUser }]}
                    >
                      <MentionChipIcon mention={mention} />
                      <Text
                        numberOfLines={1}
                        style={{
                          color: tokens.chatUserForeground,
                          flexShrink: 1,
                          ...nativeTextStyle("capsule"),
                        }}
                      >
                        {mention.name}
                      </Text>
                      <Pressable
                        accessibilityLabel={t("Remove mention {name}", {
                          name: mention.name,
                        })}
                        hitSlop={8}
                        onPress={() =>
                          setSelectedMentions((current) =>
                            current.filter(
                              (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                            ),
                          )
                        }
                      >
                        <NativeSymbol
                          ios="xmark"
                          android="close"
                          size={12}
                          color={tokens.mutedForeground}
                        />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : undefined
            }
            trailing={
              <>
                <ComposerButton label={t("Attach file")} onPress={showAttachMenu}>
                  <NativeSymbol ios="plus" android="add" size={17} color={tokens.mutedForeground} />
                </ComposerButton>
                {canSend ? (
                  <ComposerButton
                    label={t("Send")}
                    tone="primary"
                    disabled={sending}
                    onPress={() => void send()}
                  >
                    <NativeSymbol
                      ios="arrow.up"
                      android="arrow-up"
                      size={16}
                      color={tokens.primaryForeground}
                    />
                  </ComposerButton>
                ) : (
                  // Reserves Send's footprint so the field does not jump when it arrives.
                  <View
                    accessibilityElementsHidden
                    style={{ width: sizes.composerIcon, height: sizes.composerIcon }}
                  />
                )}
                {working ? (
                  <ComposerButton
                    label={t("Stop")}
                    tone="secondary"
                    disabled={sending}
                    onPress={() => void stop()}
                  >
                    <NativeSymbol
                      ios="stop.fill"
                      android="stop"
                      size={13}
                      color={tokens.foreground}
                    />
                  </ComposerButton>
                ) : null}
              </>
            }
          >
            <TextInput
              value={draft}
              onChangeText={updateDraft}
              accessibilityLabel={
                displayName ? t("Message {name}", { name: displayName }) : t("Message")
              }
              onKeyPress={(event) => {
                if (
                  event.nativeEvent.key === "Backspace" &&
                  draft.length === 0 &&
                  (selectedSkill !== null || selectedMentions.length > 0)
                ) {
                  removeLastChip();
                }
              }}
              placeholder={
                selectedSkill || selectedMentions.length
                  ? undefined
                  : displayName
                    ? t("Message {name}", { name: displayName })
                    : t("Message…")
              }
              placeholderTextColor={tokens.foregroundSubtle}
              keyboardAppearance={colorScheme}
              multiline
              textAlignVertical="center"
              blurOnSubmit={false}
              style={{
                color: tokens.foreground,
                paddingVertical: 4,
                maxHeight: 100,
                writingDirection: "auto",
                ...nativeTextStyle("body"),
              }}
            />
          </ComposerShell>
        </View>
      </View>
      <Modal
        visible={botActionsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setBotActionsOpen(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            padding: 24,
            backgroundColor: tokens.overlay,
          }}
        >
          <Pressable
            accessibilityLabel={t("Cancel")}
            onPress={() => setBotActionsOpen(false)}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
            }}
          />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: tokens.popover,
              borderRadius: 24,
              paddingVertical: 12,
            }}
          >
            {botActions.map((action) => (
              <Pressable
                key={action.text}
                accessibilityRole="button"
                onPress={() => {
                  setBotActionsOpen(false);
                  action.onPress();
                }}
                style={{
                  minHeight: 56,
                  justifyContent: "center",
                  paddingHorizontal: 24,
                }}
              >
                <Text
                  style={{
                    color: action.destructive ? tokens.destructive : tokens.popoverForeground,
                    fontSize: 16,
                  }}
                >
                  {action.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
      {markdownPreview && artifactTarget ? (
        <MarkdownArtifactPreview
          threadTarget={artifactTarget}
          target={markdownPreview}
          onClose={() => setMarkdownPreview(null)}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={16} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={16}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>G</Text>
      </View>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>@</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}

/** A round 34 pt control of the composer capsule; `hitSlop` brings the tap
 * target back to 44 pt without widening the capsule. */
function ComposerButton({
  label,
  onPress,
  disabled,
  tone = "plain",
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "plain" | "primary" | "secondary";
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={5}
      onPress={onPress}
      style={({ pressed }) => ({
        width: sizes.composerIcon,
        height: sizes.composerIcon,
        borderRadius: radii.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor:
          tone === "primary"
            ? tokens.primary
            : tone === "secondary"
              ? tokens.secondary
              : "transparent",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={13} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={13}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>
          {mention.kind === "group" ? "G" : "@"}
        </Text>
      </View>
    );
  }
  return (
    <BotAvatar
      color={mention.color ?? tokens.mutedForeground}
      identity={mention.id}
      shapeSeed={mention.shapeSeed}
      size={sizes.chip}
    />
  );
}

function previewMessageText(message: MobileMessage): string {
  const text = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`,
        ];
      }
      if (
        (block.kind === "text" ||
          block.kind === "bot_message_sent" ||
          block.kind === "bot_message_received") &&
        block.text
      ) {
        return [block.text];
      }
      return [];
    })
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return t("Attachment");
  }
  return t("Message");
}

function memberName(
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

async function speakMessage(botId: string, message: MobileMessage) {
  const text = blockText(message);
  if (!text.trim()) return;
  if (!(await speakText(text, { botId }))) {
    throw new Error(t("Add a voice provider in Voice settings."));
  }
}

type MessageActionProps = Pick<
  TextProps,
  "onLongPress" | "accessibilityActions" | "onAccessibilityAction"
>;

const MessageBubble = memo(function MessageBubble({
  botId,
  botName,
  bots,
  groupId,
  message,
  members,
  replyPreview,
  canAnswer,
  onAnswer,
  onOpenBot,
  onPreviewMarkdown,
  actionProps,
}: {
  botId: string;
  botName?: string;
  bots: MobileBot[];
  groupId?: string;
  message: MobileMessage;
  members?: MobileSnapshot["members"];
  replyPreview?: MobileMessage;
  canAnswer: boolean;
  onAnswer: (message: MobileMessage, answer: string) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  actionProps: MessageActionProps;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const showSteps = useDisplayAgentSteps();
  const artifactTarget: MobileArtifactTarget = groupId ? { groupId } : { botId };
  const cardBotId = message.botId ?? botId;
  const appConnectBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "app_connect" }> =>
      block.kind === "app_connect",
  );
  const questionsAsk = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && Boolean(block.questions?.length),
  );
  if (questionsAsk) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <MultiQuestionAskBlock
          ask={questionsAsk}
          actionProps={actionProps}
          canAnswer={canAnswer}
          onAnswer={(answer) => onAnswer(message, answer)}
          messageId={message.id}
        />
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const ask = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" &&
      !isApprovalAskBlock(block) &&
      !block.actions?.length &&
      !block.questions?.length,
  );
  if (ask) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <AskBlock
          ask={ask}
          actionProps={actionProps}
          canAnswer={canAnswer}
          onAnswer={(answer) => onAnswer(message, answer)}
        />
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const botColorOf = (id: string | undefined) =>
    bots.find((bot) => bot.id === id)?.color ??
    members?.find((member) => member.botId === id)?.color ??
    tokens.mutedForeground;
  const avatarOf = (id: string | undefined) => ({
    color: botColorOf(id),
    identity: id,
    shapeSeed: members?.find((member) => member.botId === id)?.shapeSeed,
  });
  // An aside is a note between messages, not something a bot said: like the
  // web transcript it carries no author, no bubble and no message actions.
  const handoff = message.blocks.find((block) => block.kind === "handoff");
  if (handoff) {
    const from = memberName(members, handoff.fromBotId) ?? t("bot");
    const to = memberName(members, handoff.toBotId) ?? t("bot");
    const label = t("{from} messaged {to}", { from, to });
    return (
      <Interstitial
        avatars={
          <StackedAvatars
            items={[avatarOf(handoff.fromBotId), avatarOf(handoff.toBotId)]}
            size={sizes.stackXs}
          />
        }
      >
        {handoff.text ? `${label} · ${handoff.text}` : label}
      </Interstitial>
    );
  }
  const peerMessage = message.blocks.find(
    (
      block,
    ): block is Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }> =>
      block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
  if (peerMessage) {
    const sent = peerMessage.kind === "bot_message_sent";
    const peer = sent ? peerMessage.toBotName : peerMessage.fromBotName;
    const peerBotId = sent ? peerMessage.toBotId : peerMessage.fromBotId;
    const label = sent
      ? t("Messaged {peer}", { peer: peer ?? t("Bot") })
      : t("Message from {peer}", { peer: peer ?? t("Bot") });
    const pair = sent ? [cardBotId, peerBotId] : [peerBotId, cardBotId];
    // Compact receipt only: peer bodies stay out of the human thread; the full
    // view-only exchange opens on its own screen.
    return (
      <Interstitial
        accessibilityLabel={label}
        avatars={<StackedAvatars items={pair.map(avatarOf)} size={sizes.stackXs} />}
        onPress={() =>
          router.push({
            pathname: "/peer-messages",
            params: {
              botId: cardBotId,
              botName: memberName(members, cardBotId) ?? botName ?? "",
              botColor: botColorOf(cardBotId),
              peerBotId,
              peerBotName: peer ?? "",
              peerColor: botColorOf(peerBotId),
            },
          })
        }
      >
        {label}
      </Interstitial>
    );
  }
  const channelMessage = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
      block.kind === "channel_message",
  );
  if (channelMessage) {
    return (
      <Interstitial avatars={null}>
        {`${messagingProviderLabel(channelMessage.provider, channelMessage.transport)} · ${
          channelMessage.fromLabel
        }: ${channelMessage.text}`}
      </Interstitial>
    );
  }
  const metaNote = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "meta" }> => block.kind === "meta",
  );
  if (metaNote) {
    return <Interstitial avatars={null}>{metaNote.text}</Interstitial>;
  }
  const routineRun = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "routine_run" }> =>
      block.kind === "routine_run",
  );
  if (routineRun) {
    return <RoutineRunCard block={routineRun} actionProps={actionProps} />;
  }
  const special = message.blocks.find(
    (block) =>
      block.kind === "subagent" || block.kind === "child_bot" || block.kind === "cloud_agent",
  );
  if (special?.kind === "subagent") {
    const running = special.status === "running";
    const failed = special.status === "failed";
    return (
      <Pressable {...actionProps} style={{ width: "90%" }}>
        <Surface style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: 15,
                fontWeight: "600",
              }}
            >
              {special.name || t("subagent")}
            </Text>
            <Text
              style={{
                color: failed
                  ? tokens.destructive
                  : running
                    ? tokens.mutedForeground
                    : tokens.success,
                ...nativeTextStyle("label"),
              }}
            >
              {running
                ? t("Running")
                : special.status === "failed"
                  ? t("Failed")
                  : special.status === "completed"
                    ? t("Completed")
                    : special.status}
            </Text>
          </View>
          {special.task ? (
            <Text
              style={{ color: tokens.mutedForeground, marginTop: 8, ...nativeTextStyle("meta") }}
            >
              {special.task}
            </Text>
          ) : null}
          {special.result || special.progress ? (
            <View style={{ marginTop: 8 }}>
              <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={running}>
                {special.result || special.progress || ""}
              </ChatMarkdown>
            </View>
          ) : null}
        </Surface>
      </Pressable>
    );
  }
  if (special?.kind === "cloud_agent") {
    const title = special.title || t("Cloud agent");
    const statusLabel =
      special.status === "running"
        ? t("running")
        : special.status === "finished"
          ? t("finished")
          : special.status === "cancelled"
            ? t("cancelled")
            : t("failed");
    const failed = special.status === "failed";
    const finished = special.status === "finished";
    const prHref = cloudAgentHttpsUrl(special.prUrl);
    const href = prHref ?? cloudAgentHttpsUrl(special.url);
    return (
      <Pressable
        onPress={() => {
          if (href) Linking.openURL(href).catch(() => undefined);
        }}
        testID="cloud-agent-card"
        accessibilityRole={href ? "link" : "text"}
        accessibilityLabel={`${title}: ${statusLabel}`}
        disabled={!href}
        style={{ width: "90%" }}
      >
        <Surface style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: tokens.cardForeground, fontSize: 15, fontWeight: "600" }}>
              {title}
            </Text>
            <Text
              style={{
                color: failed
                  ? tokens.destructive
                  : finished
                    ? tokens.success
                    : tokens.mutedForeground,
                ...nativeTextStyle("label"),
              }}
            >
              {statusLabel}
            </Text>
          </View>
          {prHref ? (
            <Text
              style={{ color: tokens.mutedForeground, marginTop: 8, ...nativeTextStyle("meta") }}
            >
              {t("Pull request")}
            </Text>
          ) : special.branch ? (
            <Text
              style={{ color: tokens.mutedForeground, marginTop: 8, ...nativeTextStyle("meta") }}
            >
              {special.branch}
            </Text>
          ) : null}
        </Surface>
      </Pressable>
    );
  }
  if (special?.kind === "child_bot") {
    const removed = special.status === "deleted" || special.status === "archived";
    return (
      <Pressable
        {...actionProps}
        onPress={
          removed ? undefined : () => onOpenBot(special.botId ?? "", special.name ?? t("Bot"))
        }
        style={{ width: "90%", opacity: removed ? 0.6 : 1 }}
      >
        <Surface style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: 15,
                fontWeight: "600",
              }}
            >
              {special.name || t("Bot")}
            </Text>
            <Text
              style={{
                color: removed ? tokens.destructive : tokens.success,
                ...nativeTextStyle("label"),
              }}
            >
              {special.status === "archived"
                ? t("archived")
                : special.status === "deleted"
                  ? t("deleted")
                  : t("bot")}
            </Text>
          </View>
          <Text style={{ color: tokens.mutedForeground, marginTop: 8, ...nativeTextStyle("meta") }}>
            {removed
              ? special.status === "archived"
                ? t("Archived. Chat, memory, and files kept.")
                : t("Removed with chat, computer, and memory.")
              : special.title || t("Opened its thread.")}
          </Text>
        </Surface>
      </Pressable>
    );
  }
  if (appConnectBlocks.length > 0 && appConnectBlocks.length === message.blocks.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const askBlock = message.blocks.find(
    (block) => block.kind === "ask" && Boolean(block.actions?.length),
  );
  if (askBlock?.kind === "ask" && askBlock.actions?.length) {
    const approval = isApprovalAskBlock(askBlock);
    // The row above already names the bot; the card only repeats itself for a
    // consequential approval, name-less. A question with fixed options opens
    // with no header.
    const header = approval ? { who: t("Needs your call") } : undefined;
    const answeredLine =
      askBlock.status === "answered"
        ? formatApprovalAnswer(askBlock.answer, askBlock.actions, approval)
        : !canAnswer
          ? t("No longer active")
          : undefined;
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <FramedBlock
          header={header ? { ...header, dot: answeredLine === undefined } : undefined}
          question={<Text {...actionProps}>{askBlock.text}</Text>}
          consequence={askBlock.detail}
          answered={answeredLine}
          actions={
            answeredLine === undefined ? (
              <AskActions
                actions={askBlock.actions}
                approval={approval}
                allowFreeText={!approval}
                accessibilityActions={actionProps.accessibilityActions}
                onAccessibilityAction={actionProps.onAccessibilityAction}
                onAnswer={(answer) => onAnswer(message, answer)}
              />
            ) : undefined
          }
        />
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </View>
    );
  }
  const attachments = message.blocks.filter(
    (block) => block.kind === "image" || block.kind === "file",
  );
  const caption = message.blocks
    .flatMap((block) => {
      if (block.kind === "channel_message" && block.text) {
        return [
          `${messagingProviderLabel(block.provider, block.transport)} · ${block.fromLabel}: ${block.text}`,
        ];
      }
      return block.kind === "text" && block.text ? [block.text] : [];
    })
    .join("\n");
  if (attachments.length > 0) {
    // The author now lives in the row above (`MessageRow`), so the card only
    // carries what was attached.
    return (
      <Surface
        style={{
          maxWidth: "100%",
          alignSelf: message.role === "user" ? "flex-end" : "flex-start",
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
          ...(message.role === "user" ? { backgroundColor: tokens.chatUser } : null),
        }}
      >
        {replyPreview || (message.replyToMessageId && message.replyQuote) ? (
          <Text
            style={{
              color: message.role === "user" ? tokens.chatUserForeground : tokens.mutedForeground,
              ...nativeTextStyle("meta"),
            }}
            numberOfLines={2}
          >
            {message.replyQuote
              ? `“${message.replyQuote}”`
              : replyPreview
                ? previewMessageText(replyPreview)
                : ""}
          </Text>
        ) : null}
        {caption ? (
          <Text
            style={{
              color: message.role === "user" ? tokens.chatUserForeground : tokens.foreground,
              ...nativeTextStyle("body"),
            }}
          >
            {caption}
          </Text>
        ) : null}
        {attachments.map((attachment, index) =>
          attachment.kind === "image" ? (
            <Pressable
              {...actionProps}
              key={`${attachment.artifactId ?? attachment.name ?? "image"}-${index}`}
              onPress={() =>
                attachment.artifactId
                  ? void openMobileArtifact(
                      artifactTarget,
                      attachment.artifactId,
                      attachment.name ?? t("Image"),
                      attachment.mimeType ?? "image/png",
                    ).catch((err) =>
                      Alert.alert(
                        t("Could not open image"),
                        err instanceof Error ? err.message : t("Try again."),
                      ),
                    )
                  : undefined
              }
            >
              <Text
                style={{
                  color: message.role === "user" ? tokens.chatUserForeground : tokens.foreground,
                  ...nativeTextStyle("body"),
                }}
              >
                🖼 {attachment.name ?? t("Image")}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              {...actionProps}
              key={`${attachment.artifactId ?? attachment.name ?? "file"}-${index}`}
              onPress={() =>
                attachment.artifactId
                  ? attachment.mimeType === "text/markdown"
                    ? onPreviewMarkdown({
                        artifactId: attachment.artifactId,
                        name: attachment.name ?? t("Markdown file"),
                        mimeType: attachment.mimeType,
                      })
                    : void openMobileArtifact(
                        artifactTarget,
                        attachment.artifactId,
                        attachment.name ?? t("File"),
                        attachment.mimeType ?? "text/plain",
                      ).catch((err) =>
                        Alert.alert(
                          t("Could not open file"),
                          err instanceof Error ? err.message : t("Try again."),
                        ),
                      )
                  : undefined
              }
            >
              <Text
                style={{
                  color: message.role === "user" ? tokens.chatUserForeground : tokens.foreground,
                  ...nativeTextStyle("body"),
                }}
              >
                📎 {attachment.name ?? t("File")}
              </Text>
              {attachment.size ? (
                <Text
                  style={{
                    color:
                      message.role === "user" ? tokens.chatUserForeground : tokens.mutedForeground,
                    marginTop: 4,
                    ...nativeTextStyle("meta"),
                  }}
                >
                  {attachment.mimeType ?? "file"} · {attachment.size} bytes
                </Text>
              ) : null}
            </Pressable>
          ),
        )}
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard
            key={`${block.provider}-${index}`}
            botId={cardBotId}
            block={block}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
          />
        ))}
      </Surface>
    );
  }
  const segments = messagePresentationSegments(message.blocks);
  const steps = showSteps ? stepsBlocks(message.blocks) : [];
  const live = message.id.startsWith("progress:");
  const firstContent = segments.findIndex((segment) => segment.kind === "content");
  return (
    <View style={{ gap: 8, width: "100%" }}>
      {steps.map((block, index) => (
        <AgentSteps key={`${message.id}-steps-${index}`} block={block} live={live} />
      ))}
      {segments.map((segment, index) => (
        <MessageText
          key={`${message.id}-content-${index}`}
          message={{ ...message, blocks: segment.blocks }}
          replyPreview={index === firstContent ? replyPreview : undefined}
          actionProps={actionProps}
        />
      ))}
      {appConnectBlocks.map((block, index) => (
        <AppConnectCard
          key={`${block.provider}-${index}`}
          botId={cardBotId}
          block={block}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      ))}
    </View>
  );
});

/** "3m ago"-style label from an ISO timestamp, in the active UI locale. Falls
    back to a clock time when `Intl.RelativeTimeFormat` isn't available. */
function routineRunTimeLabel(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const locale = dateLocaleForUi();
  const diffMin = Math.round((Date.now() - date.getTime()) / 60_000);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (Math.abs(diffMin) < 1) return rtf.format(0, "minute");
    if (Math.abs(diffMin) < 60) return rtf.format(-diffMin, "minute");
    const diffHour = Math.round(diffMin / 60);
    if (Math.abs(diffHour) < 24) return rtf.format(-diffHour, "hour");
    return rtf.format(-Math.round(diffHour / 24), "day");
  } catch {
    return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  }
}

/** Native routine-run card: a sub-bot's routine traced by its run lifecycle
    (queued/running/completed/failed/cancelled) instead of a free closing
    text. Mirrors the web `RoutineRunCard`'s semantics; visual template is the
    `subagent` card above. Collapsed by default, expanded when the routine's
    `notify` toggle is on (spec CA2/CA13). The digest is untrusted content
    (a sub-bot's routine can summarize scanned mail or web pages): it is
    rendered as sanitized markdown via `ChatMarkdown`, with remote images
    blocked (`allowImages={false}`) so no remote resource is ever loaded from
    it (threat model S1, spec CA-R5/CA-R12). The card's chrome never carries
    the bot's color (spec CA-R10): a subscribed routine is only ever
    distinguished by being expanded by default and by a monochrome bell. */
function RoutineRunCard({
  block,
  actionProps,
}: {
  block: Extract<MessageBlock, { kind: "routine_run" }>;
  actionProps: MessageActionProps;
}) {
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const digest = block.digest?.trim() || undefined;
  const subscribed = Boolean(block.notify);
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? subscribed;
  const statusColor =
    block.state === "completed"
      ? tokens.success
      : block.state === "failed"
        ? tokens.destructive
        : tokens.mutedForeground;
  const statusLabel =
    block.state === "queued"
      ? t("Queued")
      : block.state === "running"
        ? t("Running")
        : block.state === "completed"
          ? t("Completed")
          : block.state === "failed"
            ? t("Failed")
            : t("Cancelled");
  const timeLabel = routineRunTimeLabel(
    block.state === "queued" || block.state === "running"
      ? block.startedAt
      : (block.endedAt ?? block.startedAt),
  );
  return (
    <Pressable {...actionProps} style={{ width: "90%" }}>
      <Surface
        style={{
          paddingHorizontal: 16,
          paddingVertical: 14,
          gap: 6,
        }}
      >
        {/* The routine name owns the full width and is never truncated by the
            state pill or timestamp (explicit requirement): they always sit on
            their own row below it, not squeezed onto the same line. */}
        <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
          {block.routineName}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {block.state === "running" ? (
            <ShimmerText
              style={{ color: statusColor, ...nativeTextStyle("label", { weight: 600 }) }}
            >
              {`● ${statusLabel}`}
            </ShimmerText>
          ) : (
            // The dot never carries the status alone: the word is always shown too.
            <Text style={{ color: statusColor, ...nativeTextStyle("label", { weight: 600 }) }}>
              {`● ${statusLabel}`}
            </Text>
          )}
          {timeLabel ? (
            <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("time") }}>
              {timeLabel}
            </Text>
          ) : null}
          {subscribed ? (
            <View accessibilityRole="image" accessibilityLabel={t("Notifications on")}>
              <NativeSymbol
                ios="bell"
                android="notifications-outline"
                size={14}
                color={tokens.mutedForeground}
              />
            </View>
          ) : null}
        </View>
        {block.headline ? (
          <Text
            numberOfLines={1}
            style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}
          >
            {block.headline}
          </Text>
        ) : null}
        {digest ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? t("Hide details") : t("Show details")}
            onPress={() => setManualExpanded(!expanded)}
            hitSlop={15}
            style={{ flexDirection: "row", alignItems: "center", marginTop: 2 }}
          >
            <NativeSymbol
              ios={expanded ? "chevron.up" : "chevron.down"}
              android={expanded ? "chevron-up-outline" : "chevron-down-outline"}
              size={14}
              color={tokens.mutedForeground}
            />
          </Pressable>
        ) : null}
        {expanded && digest ? (
          <ScrollView style={{ maxHeight: 260 }} nestedScrollEnabled>
            <ChatMarkdown allowImages={false} palette={tokens} colorScheme={colorScheme}>
              {truncateMarkdownForRender(digest)}
            </ChatMarkdown>
          </ScrollView>
        ) : null}
      </Surface>
    </Pressable>
  );
}

/**
 * What was said: the person's words in the one filled bubble of the thread,
 * a bot's in prose the thread does not frame.
 */
function MessageText({
  message,
  replyPreview,
  actionProps,
}: {
  message: MobileMessage;
  replyPreview?: MobileMessage;
  actionProps: MessageActionProps;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const contentText = blockText(message);
  if (!contentText) return null;
  const parent =
    replyPreview || (message.replyToMessageId && message.replyQuote) ? (
      <Text
        numberOfLines={2}
        style={{
          marginBottom: 6,
          color: tokens.mutedForeground,
          ...nativeTextStyle("meta"),
        }}
      >
        {message.replyQuote
          ? `“${message.replyQuote}”`
          : replyPreview
            ? previewMessageText(replyPreview)
            : ""}
      </Text>
    ) : null;
  if (message.role === "user") {
    return (
      <View style={{ alignItems: "flex-end" }}>
        {parent}
        <UserBubble {...actionProps}>{contentText}</UserBubble>
      </View>
    );
  }
  return (
    <Pressable {...actionProps} style={{ minWidth: 0, maxWidth: "100%" }}>
      {parent}
      <ChatMarkdown
        palette={tokens}
        colorScheme={colorScheme}
        streaming={message.id.startsWith("progress:")}
      >
        {contentText}
      </ChatMarkdown>
    </Pressable>
  );
}

function AskBlock({
  ask,
  canAnswer,
  onAnswer,
  actionProps,
}: {
  ask: Extract<MobileMessage["blocks"][number], { kind: "ask" }>;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
  actionProps: MessageActionProps;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const answered = ask.status === "answered";
  const secretInput = isSecretAskBlock(ask);
  const secretLabel =
    ask.purpose === "password"
      ? t("Password")
      : ask.purpose === "api_key"
        ? t("API key")
        : t("Code");
  const submitLabel = secretInput ? t("Save") : t("Send answer");
  const submittingLabel = secretInput ? t("Saving…") : t("Sending…");

  async function submit() {
    if (submitting) return;
    if (secretInput ? answer.length === 0 : !answer.trim()) return;
    const submitValue = secretInput ? answer : answer.trim();
    setSubmitting(true);
    setError(null);
    if (secretInput) setAnswer("");
    try {
      await onAnswer(submitValue);
    } catch (cause) {
      setError(!secretInput && cause instanceof Error ? cause.message : t("Could not send answer"));
    } finally {
      setSubmitting(false);
    }
  }

  const answeredLine = answered
    ? secretInput
      ? t("Saved")
      : t("Answered: {answer}", { answer: ask.answer ?? t("Done") })
    : !canAnswer
      ? t("Waiting for this bot’s response.")
      : undefined;
  const disabled = (secretInput ? answer.length === 0 : !answer.trim()) || submitting;

  return (
    <FramedBlock
      question={<Text {...actionProps}>{ask.text}</Text>}
      consequence={secretInput ? ask.credential?.origin : ask.detail}
      answered={answeredLine}
      actions={
        answeredLine === undefined ? (
          <CapsuleButton
            kind="primary"
            height={sizes.mobileStack}
            label={submitting ? submittingLabel : submitLabel}
            disabled={disabled}
            onPress={() => void submit()}
          />
        ) : undefined
      }
    >
      {answeredLine === undefined ? (
        <View style={{ gap: 10 }}>
          <TextInput
            accessibilityLabel={secretInput ? secretLabel : t("Answer")}
            value={answer}
            onChangeText={setAnswer}
            placeholder={secretInput ? secretLabel : t("Type your answer")}
            placeholderTextColor={tokens.mutedForeground}
            secureTextEntry={secretInput}
            autoComplete="off"
            autoCorrect={secretInput ? false : undefined}
            autoCapitalize={secretInput ? "none" : "sentences"}
            editable={!submitting}
            onSubmitEditing={() => void submit()}
            style={{
              minHeight: 44,
              borderRadius: radii.card,
              borderWidth: 1,
              borderColor: tokens.outline,
              backgroundColor: tokens.surface,
              color: tokens.foreground,
              paddingHorizontal: 14,
              paddingVertical: 10,
              ...nativeTextStyle("body"),
            }}
          />
          {error ? (
            <Text style={{ color: tokens.destructive, ...nativeTextStyle("meta") }}>{error}</Text>
          ) : null}
        </View>
      ) : null}
    </FramedBlock>
  );
}

type MobileLocalAnswer = {
  selected: string[];
  other: string;
  otherOpen: boolean;
  skipped: boolean;
};

function mobileAnswered(a: MobileLocalAnswer): boolean {
  return a.selected.length > 0 || a.other.trim().length > 0;
}

type MobileAskDraft = { answers: Record<string, MobileLocalAnswer>; index: number };
// Keep an in-progress multi-question draft while the card unmounts (leaving and returning to the
// thread), keyed by the ask message id, until it is submitted.
const mobileAskDrafts = new Map<string, MobileAskDraft>();

function MultiQuestionAskBlock({
  ask,
  canAnswer,
  onAnswer,
  actionProps,
  messageId,
}: {
  ask: Extract<MobileMessage["blocks"][number], { kind: "ask" }>;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
  actionProps: MessageActionProps;
  messageId: string;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const questions = ask.questions ?? [];
  const [index, setIndex] = useState(() => mobileAskDrafts.get(messageId)?.index ?? 0);
  const [answers, setAnswers] = useState<Record<string, MobileLocalAnswer>>(
    () => mobileAskDrafts.get(messageId)?.answers ?? {},
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mobileAskDrafts.set(messageId, { answers, index });
  }, [messageId, answers, index]);

  const total = questions.length;
  const current = questions[index]!;
  const isLast = index === total - 1;
  const answered = ask.status === "answered";
  const get = (id: string): MobileLocalAnswer =>
    answers[id] ?? { selected: [], other: "", otherOpen: false, skipped: false };

  function update(id: string, patch: Partial<MobileLocalAnswer>) {
    setAnswers((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] ?? { selected: [], other: "", otherOpen: false, skipped: false }),
        ...patch,
      },
    }));
  }

  function toggleOption(optionId: string) {
    const state = get(current.id);
    if (current.multiSelect) {
      const selected = state.selected.includes(optionId)
        ? state.selected.filter((id) => id !== optionId)
        : [...state.selected, optionId];
      update(current.id, { selected, skipped: false });
    } else {
      const selected = state.selected[0] === optionId ? [] : [optionId];
      update(current.id, { selected, other: "", skipped: false });
    }
  }

  const requiredSatisfied = questions.every(
    (question) => question.required === false || mobileAnswered(get(question.id)),
  );

  async function submit() {
    if (submitting || !requiredSatisfied) return;
    const payload: Record<string, { selected?: string[]; other?: string; skipped?: boolean }> = {};
    for (const question of questions) {
      const state = get(question.id);
      const other = state.other.trim();
      if (mobileAnswered(state)) {
        payload[question.id] = {
          ...(state.selected.length ? { selected: state.selected } : {}),
          ...(other ? { other } : {}),
        };
      } else {
        payload[question.id] = { skipped: true };
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(JSON.stringify({ answers: payload }));
      mobileAskDrafts.delete(messageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not submit these answers"));
    } finally {
      setSubmitting(false);
    }
  }

  const progressRow = (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {questions.map((question, dotIndex) => {
          const done = answered || mobileAnswered(get(question.id));
          const active = !answered && dotIndex === index;
          return (
            <View
              key={question.id}
              style={{
                height: 6,
                width: active ? 22 : 6,
                borderRadius: 3,
                backgroundColor: active
                  ? tokens.foreground
                  : done
                    ? tokens.success
                    : tokens.mutedForeground,
                opacity: active ? 1 : done ? 1 : 0.4,
              }}
            />
          );
        })}
      </View>
      {!answered ? (
        <Text
          style={{ color: tokens.mutedForeground, ...nativeTextStyle("label", { weight: 600 }) }}
        >
          {index + 1}/{total}
        </Text>
      ) : null}
    </View>
  );

  const answeredContent =
    answered || !canAnswer ? (
      <View style={{ gap: 10 }}>
        {progressRow}
        {answered ? (
          <View style={{ gap: 10 }}>
            {questions.map((question, qIndex) => {
              const stored = ask.answers?.[question.id];
              const labels = (stored?.selected ?? []).map(
                (id) => question.options?.find((option) => option.id === id)?.label ?? id,
              );
              if (stored?.other) labels.push(`${t("Other")}: ${stored.other}`);
              const value =
                stored?.skipped && labels.length === 0 ? t("Skipped") : labels.join(", ");
              return (
                <View key={question.id}>
                  <Text
                    style={{
                      color: tokens.mutedForeground,
                      ...nativeTextStyle("meta", { weight: 600 }),
                    }}
                  >
                    {qIndex + 1}. {question.question}
                  </Text>
                  <Text style={{ color: tokens.foreground, ...nativeTextStyle("body") }}>
                    {value || t("Answered")}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : (
          <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
            {t("No longer active")}
          </Text>
        )}
      </View>
    ) : undefined;

  const optionEntries = current.options ?? [];
  const withOther =
    optionEntries.length && current.multiSelect
      ? [...optionEntries, { id: "__other__", label: t("Other…") }]
      : optionEntries;
  const selectedIds = [
    ...get(current.id).selected,
    ...(get(current.id).otherOpen ? ["__other__"] : []),
  ];
  const showOtherField =
    !current.options?.length || !current.multiSelect || get(current.id).otherOpen;

  return (
    <FramedBlock
      question={
        <>
          {current.header ? (
            <Text
              style={{
                alignSelf: "flex-start",
                marginBottom: 4,
                borderRadius: radii.chip,
                backgroundColor: tokens.muted,
                paddingHorizontal: 10,
                paddingVertical: 2,
                color: tokens.mutedForeground,
                ...nativeTextStyle("time"),
              }}
            >
              {current.header}
            </Text>
          ) : null}
          <Text {...actionProps}>{current.question}</Text>
        </>
      }
      answered={answeredContent}
      actions={
        answeredContent === undefined ? (
          <View style={{ gap: 8 }}>
            {index > 0 ? (
              <CapsuleButton
                kind="tertiary"
                height={TERTIARY_CAPSULE_HEIGHT}
                label={t("Back")}
                disabled={submitting}
                onPress={() => setIndex(index - 1)}
              />
            ) : null}
            {current.required === false ? (
              <CapsuleButton
                kind="tertiary"
                height={TERTIARY_CAPSULE_HEIGHT}
                label={t("Skip")}
                disabled={submitting}
                onPress={() => {
                  update(current.id, { selected: [], other: "", skipped: true });
                  if (!isLast) setIndex(index + 1);
                }}
              />
            ) : null}
            <CapsuleButton
              kind="primary"
              height={sizes.mobileStack}
              label={isLast ? (submitting ? t("Sending…") : t("Send answers")) : t("Next")}
              disabled={submitting || (isLast && !requiredSatisfied)}
              onPress={() => (isLast ? void submit() : setIndex(index + 1))}
            />
          </View>
        ) : undefined
      }
    >
      {answeredContent === undefined ? (
        <View style={{ gap: 10 }}>
          {progressRow}
          <QuickReplyCapsules
            options={withOther}
            selectedIds={selectedIds}
            disabled={submitting}
            multiSelect={current.multiSelect}
            onSelect={(id) => {
              if (id === "__other__") {
                const open = !get(current.id).otherOpen;
                update(current.id, {
                  otherOpen: open,
                  ...(open ? {} : { other: "" }),
                  skipped: false,
                });
              } else {
                toggleOption(id);
              }
            }}
          />
          {current.options?.length && !current.multiSelect ? (
            <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
              {t("Or type your own answer")}
            </Text>
          ) : null}
          {showOtherField ? (
            <TextInput
              value={get(current.id).other}
              onChangeText={(value) =>
                update(current.id, {
                  other: value,
                  ...(current.multiSelect || !value.trim() ? {} : { selected: [] }),
                  skipped: false,
                })
              }
              editable={!submitting}
              autoFocus={current.multiSelect && get(current.id).otherOpen}
              placeholder={
                current.options?.length ? t("Type a different answer") : t("Type your answer")
              }
              placeholderTextColor={tokens.mutedForeground}
              multiline
              style={{
                borderRadius: radii.card,
                borderWidth: 1,
                borderColor: tokens.outline,
                backgroundColor: tokens.surface,
                paddingHorizontal: 14,
                paddingVertical: 10,
                color: tokens.foreground,
                minHeight: 44,
                ...nativeTextStyle("body"),
              }}
            />
          ) : null}
          {error ? (
            <Text style={{ color: tokens.destructive, ...nativeTextStyle("meta") }}>{error}</Text>
          ) : null}
        </View>
      ) : null}
    </FramedBlock>
  );
}
