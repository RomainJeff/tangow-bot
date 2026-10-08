import type { GridNode, TableActions } from "@rakazo/chat-ui/native";
import {
  ChatMarkdown,
  hasMarkdownTable,
  LinkifiedText,
  TableActionsProvider,
  truncateMarkdownForRender,
} from "@rakazo/chat-ui/native";
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
  canEditSpawnBotCard,
  computeMessageGroups,
  foldRoutineRuns,
  isApprovalAskBlock,
  isAsideOnlyMessage,
  isRunTerminalEvent,
  isSecretAskBlock,
  latestActivityLabel,
  latestAnswerableAskMessageId,
  mentionChipKey,
  projectMessageReactions,
  type RoutineGroupRun,
  type RoutineRowRole,
  resolveComposerSendPlan,
  routineCardSettlement,
  SLASH_ACTIONS,
  type SlashActionId,
  selectedAskActionLabel,
  serializeComposerPrompt,
  showsTimeMarker,
  threadTimeMarkerLabel,
  truncateSlashDescription,
  userVisibleMessages,
} from "@rakazo/core";
import { botAccentOn, motion, radii, sizes } from "@rakazo/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import type { ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  findNodeHandle,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PixelRatio,
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
import type { SharedValue } from "react-native-reanimated";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  Keyframe,
  runOnJS,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { AppConnectCard } from "../components/AppConnectCard";
import {
  AskActions,
  CapsuleButton,
  QuickReplyCapsules,
  TERTIARY_CAPSULE_HEIGHT,
} from "../components/AskActions";
import { AgentSteps } from "../components/agent-steps";
import { AnimatedMessageBubble, MessageArrival } from "../components/animated-message-bubble";
import { BotAvatar } from "../components/bot-avatar";
import { BotBubble } from "../components/bot-bubble";
import { BuzzingAvatar } from "../components/buzzing-avatar";
import { ComposerAttachment } from "../components/composer-attachment";
import { ComposerLinkPreview } from "../components/composer-link-preview";
import { ComposerAttachBubble, ComposerShell } from "../components/composer-shell";
import { DictationPreview } from "../components/dictation-preview";
import { FramedBlock } from "../components/framed-block";
import { GroupAvatar } from "../components/group-avatar";
import { HandoffDivider, Interstitial } from "../components/interstitial";
import { LinkPreviewCard } from "../components/link-preview-card";
import {
  MarkdownArtifactPreview,
  type MarkdownArtifactPreviewTarget,
} from "../components/markdown-artifact-preview";
import type { MessageSheetAction } from "../components/message-actions-sheet";
import { MessageActionsSheet } from "../components/message-actions-sheet";
import { MessageRow } from "../components/message-row";
import { NativeSymbol } from "../components/native-symbol";
import { PreviewSheet } from "../components/preview-sheet";
import { ReactionPill } from "../components/reaction-pill";
import { RoutineCardPreview } from "../components/routine-card-preview";
import { ShimmerText } from "../components/shimmer-text";
import { StackedAvatars } from "../components/stacked-avatars";
import { StopContour } from "../components/stop-contour";
import { Surface } from "../components/surface";
import { TablePreview } from "../components/table-preview";
import { TypingBubble } from "../components/typing-bubble";
import { UserBubble } from "../components/user-bubble";
import { useDisplayAgentSteps } from "../lib/agent-steps-pref";
import {
  applyMobileThreadEvent,
  blockText,
  copyableMobileMessageText,
  currentApiBase,
  loadSessionToken,
  type MobileBot,
  type MobileGroup,
  type MobileMe,
  type MobileMessage,
  type MobileMessagePage,
  type MobileSnapshot,
  type MobileSpaceNavigation,
  mergeMobileSnapshot,
  messagingProviderLabel,
  prependMobileMessagePage,
  rpc,
  selectedSpaceId,
  selectSpace,
  shouldApplyMobileThreadRefresh,
  subscribeThread,
} from "../lib/api";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { type MobileArtifactTarget, openMobileArtifact } from "../lib/artifact-open";
import { presentAttachSheet } from "../lib/attach-sheet";
import { confirmDeleteBot } from "../lib/bot-lifecycle";
import { CHAT_MOTION, useChatReducedMotion } from "../lib/chat-motion";
import { cancelFocusPrompt, focusPromptThreadActive } from "../lib/focus-prompt";
import { commitHaptic, selectionHaptic, sendHaptic, successHaptic } from "../lib/haptics";
import { dateLocaleForUi, t, useI18n } from "../lib/i18n";
import { unreadConversationCount } from "../lib/inbox-spaces";
import { saveLastBotId } from "../lib/last-bot";
import {
  blocksWithoutPreviewedLinkLine,
  cardReplacesBubble,
  linkPreviewCardOf,
} from "../lib/link-preview";
import {
  dismissThreadNotifications,
  resumeLiveNotifications,
  setOpenNotificationThread,
  syncAppBadge,
} from "../lib/live-notifications";
import { messageArrivalStaggerMs, useMessageArrivals } from "../lib/message-arrivals";
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
import { reactionPopKey, useReactionPops } from "../lib/reaction-pop";
import { threadRefreshDelayMs } from "../lib/refresh";
import { closeSheet, openSheet } from "../lib/sheet";
import type { SpawnBotEdits } from "../lib/spawn-bot-edit";
import { openSpawnBotEdit, syncSpawnBotEdit } from "../lib/spawn-bot-edit";
import { hexWithAlpha } from "../lib/stop-contour-math";
import { shadowsForAppearance } from "../lib/theme";
import {
  type ThreadScrollAction,
  ThreadScrollBehavior,
  type ThreadScrollState,
} from "../lib/thread-scroll";
import { nativeTextStyle } from "../lib/typography";
import { useComposerDictation } from "../lib/use-composer-dictation";
import { useComposerLinkPreview } from "../lib/use-composer-link-preview";
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

/** 7g: a bot row whose blocks are only ever one of these is a card, not
 * narration — a decision, an ask, a routine/subagent trace, a peer-message
 * marker or a bare attachment. Swipe-to-reply is a *narration* bubble's
 * gesture only; these keep today's plain long-press wrapper. */
const CARD_ONLY_BLOCK_KINDS = new Set<string>([
  "ask",
  "handoff",
  "bot_message_sent",
  "bot_message_received",
  "channel_message",
  "meta",
  "routine_run",
  "subagent",
  "child_bot",
  "image",
  "file",
]);

/** Gaps from design contract § Grouping: 3 within a group, 14 between groups
 * (replaces the old `MESSAGE_GAP` / `ASIDE_GAP` for both rows and asides), 0
 * between two consecutive asides. */
const GROUP_GAP = 14;
const WITHIN_GROUP_GAP = 3;
/** Avatar column (`sizes.message`, 26) plus its gap (8): a bot row's
 * reactions, and a card's indent, line up under its group's prose in multi.
 * 0 in mono, which has no avatar column. */
const FRAMED_INDENT = sizes.message + 8;

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

/**
 * Lets a row that grows in place (a routine report opening) keep its header
 * still. The thread is an inverted list, so a taller row pushes the rows
 * above it up; while it moves, the list keeps the row just above it where it
 * is, natively and in the same frame, so the header stays put and only what
 * is below moves.
 */
const ThreadGrowthContext = createContext<{
  /** The row with this message id is about to change height under the person's finger. */
  hold: (rowId: string | null) => void;
} | null>(null);

/** The message id of the thread row a component is drawn in. */
const ThreadRowContext = createContext<string | null>(null);

/** The height of the `Expandable` a component is drawn in, if any. */
const ExpandableHeightContext = createContext<SharedValue<number> | null>(null);

const KEEP_VISIBLE_POSITION = { minIndexForVisible: 0 };

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
  const { locale, t } = useI18n();
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
  const [composerFocused, setComposerFocused] = useState(false);
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
  // the single source of truth for the + bubble's icon/label and the
  // attach sheet's open state — closed by `presentAttachSheet` on every path
  // out, and as a safety net below when the app returns to the foreground.
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const attachBubbleRef = useRef<View>(null);
  const textInputRef = useRef<TextInput>(null);
  const [replyTarget, setReplyTarget] = useState<MobileMessage | null>(null);
  const [rewindTarget, setRewindTarget] = useState<MobileMessage | null>(null);
  // ponytail: artifact ids ride along invisibly — mobile has no attachment chips to restore into.
  const [rewindArtifactIds, setRewindArtifactIds] = useState<string[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // The sheet a long press opened, closed if the screen moves to another thread.
  const messageSheetOwner = useRef<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownArtifactPreviewTarget | null>(
    null,
  );
  // A tapped markdown table opens whole, as records, in `TablePreview`.
  const [tablePreview, setTablePreview] = useState<GridNode | null>(null);
  // The live list's scroll offset, and whether the pinned page (a plain
  // ScrollView, not inverted) is showing instead of it.
  const listOffset = useRef(0);
  const pinnedPageShowing = useRef(false);
  // Until when a row the person opened is being held in place: the
  // follow-latest scroll stays out of its way meanwhile.
  const holdingRowUntil = useRef(0);
  // A content change that landed during the hold, replayed once it ends.
  const heldContentChange = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contentChanged = useRef(() => {});
  useEffect(() => () => clearTimeout(heldContentChange.current), []);
  // A row the person opens keeps the row just above it (the next index: the
  // list is inverted) in place instead of the latest message, so its header
  // stays put. The anchor stays set afterwards: switching it back moved the
  // thread on its own, and it keeps the same place as the latest message would
  // for everything else the thread does.
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const liveMessagesRef = useRef<readonly MobileMessage[]>([]);
  const holdRow = useCallback((rowId: string | null) => {
    holdingRowUntil.current = Date.now() + 900;
    const rows = liveMessagesRef.current;
    const index = rowId ? rows.findIndex((row) => row.id === rowId) : -1;
    if (index < 0) return;
    setAnchorIndex(Math.min(index + 1, rows.length - 1));
  }, []);
  const threadGrowth = useMemo(() => ({ hold: holdRow }), [holdRow]);
  const keptPosition = useMemo(
    () => (anchorIndex == null ? KEEP_VISIBLE_POSITION : { minIndexForVisible: anchorIndex }),
    [anchorIndex],
  );
  const tableActions = useMemo<TableActions>(
    () => ({ open: setTablePreview, label: () => t("Table"), hint: t("Opens the full table") }),
    [t],
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
  // Rule R (design contract § Grouping), computed once over the canonical
  // chronological list and indexed by id — the live inverted `FlatList` and
  // the pinned-jump chronological `ScrollView` below both read this same map,
  // so a reversed index can never move a name or an avatar (CA-7a). Every
  // message here already has visible presentation (`hasVisibleMessagePresentation`
  // above), so nothing left in the list is transparent.
  const messageGroups = useMemo(
    () => computeMessageGroups(visibleMessages, { isTransparent: () => false }),
    [visibleMessages],
  );
  const messageGroupsById = useMemo(
    () => new Map(visibleMessages.map((message, index) => [message.id, messageGroups[index]!])),
    [visibleMessages, messageGroups],
  );
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
  const linkPreview = useComposerLinkPreview(draft, notificationThreadId);
  const [attachmentsRowWidth, setAttachmentsRowWidth] = useState<number | undefined>();
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
            {inGroup && groupAvatarItems.length > 0 ? (
              <StackedAvatars
                items={groupAvatarItems}
                size={28}
                pillOverflow
                label={groupMemberNames || undefined}
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
    void rpc("threads/markRead", groupId ? { groupId } : { botId: botId! }).then(
      () => {
        void rpc<MobileSpaceNavigation>("spaces/list")
          .then((next) => syncAppBadge(unreadConversationCount(next.spaces)))
          .catch(() => undefined);
      },
      () => {
        if (readVisibleTarget.current === target) readVisibleTarget.current = null;
      },
    );
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
        // Safety net: the attach sheet can only close
        // itself while its host screen is in the foreground.
        setAttachSheetOpen(false);
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
    if (messageSheetOwner.current) closeSheet(messageSheetOwner.current);
    messageSheetOwner.current = null;
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

  // Entering dictation closes and disables both pickers — a draft starting
  // with "@" or "/" must not stay tappable while the field is read-only.
  const closePickers = useCallback(() => {
    setMentionQuery(null);
    setSlashQuery(null);
  }, []);
  const recentWriting = useCallback(
    () =>
      (snap?.messages ?? [])
        .filter((message) => message.role === "user")
        .slice(-8)
        .map((message) => blockText(message)),
    [snap?.messages],
  );
  const dictation = useComposerDictation({
    draft,
    setDraft,
    threadKey,
    closePickers,
    recentWriting,
  });

  useEffect(() => {
    if (dictation.dictating) AccessibilityInfo.announceForAccessibility(t("Dictating"));
  }, [dictation.dictating, t]);

  function insertDictation() {
    const caret = draft.length;
    dictation.insert();
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.setSelection(caret, caret);
    });
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

  // Stop contour colour: the answering bot's own identity colour in a 1:1
  // thread. A group (several bots may be working), an unknown colour, or one
  // that would vanish into the page (near-black on dark, white on light) dims
  // to `foreground`.
  const stopContourColor =
    (!inGroup && botAccentOn(currentBot?.color, resolveMobileAppearance())) ||
    hexWithAlpha(tokens.foreground, 0.45);

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

    // 7a / M2: snapshot the composer as it stands at the tap, then clear it
    // immediately — restored below if the send fails, except a rewind the
    // server already applied (`rewindApplied`), which stays applied, and
    // attachments already uploaded (unchanged behaviour: they upload again on
    // a retry, same as before this feature).
    const withoutLinkPreview = linkPreview.controller.isRemoved();
    linkPreview.controller.reset();
    const composerSnapshot = {
      draft,
      selectedMentions,
      selectedSkill,
      pendingAttachments: attachments,
      replyTarget,
      rewindTarget,
      rewindArtifactIds,
    };
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
    clearOriginComposer();
    let rewindApplied = false;
    // Once the server has the message (or the routine runs), a later failure
    // (a refresh) must not put it back in the composer to be sent twice.
    let delivered = false;

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
      if (!plan.shouldSend) {
        delivered = true;
        dropDelayedSetup();
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
      const artifactIds: string[] = composerSnapshot.rewindTarget
        ? [...composerSnapshot.rewindArtifactIds]
        : [];
      for (const pending of composerSnapshot.pendingAttachments) {
        const artifact = await rpc<{ id: string }>("artifacts/create", {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          name: pending.name,
          mimeType: pending.mimeType,
          contentBase64: pending.contentBase64,
        });
        artifactIds.push(artifact.id);
      }
      // Truncation happens here rather than on Edit, so backing out costs nothing.
      if (composerSnapshot.rewindTarget && !reroutedToGroup) {
        await rpc("threads/rewind", {
          ...(groupTarget ? { groupId: groupTarget } : { botId: botTarget! }),
          messageId: composerSnapshot.rewindTarget.id,
        });
        rewindApplied = true;
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
              replyToMessageId: reroutedToGroup ? undefined : composerSnapshot.replyTarget?.id,
              linkPreview: withoutLinkPreview ? (false as const) : undefined,
            }
          : {
              botId: botTarget!,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: composerSnapshot.replyTarget?.id,
              linkPreview: withoutLinkPreview ? (false as const) : undefined,
            },
      );
      delivered = true;
      dropDelayedSetup();
      void loadSessionToken()
        .then((token) => resumeLiveNotifications(currentApiBase(), token, selectedSpaceId() ?? ""))
        .catch(() => undefined);
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
      // 7a: restore the snapshot — an already-applied rewind stays applied,
      // and a rewind that never reached the server comes back so the person
      // doesn't lose their edit target on a retry. Attachments carry their
      // own thread key; the rest is the screen's single composer, so it only
      // comes back if the person is still on the thread they sent from.
      if (!delivered) {
        if (composerSnapshot.pendingAttachments.length) {
          setPendingAttachments((current) => [...current, ...composerSnapshot.pendingAttachments]);
        }
        if (isCurrentTarget(initialBotTarget, initialGroupTarget)) {
          setDraft(composerSnapshot.draft);
          // The person had taken the link preview off: the draft comes back without it.
          if (withoutLinkPreview) linkPreview.controller.remove();
          setSelectedMentions(composerSnapshot.selectedMentions);
          setSelectedSkill(composerSnapshot.selectedSkill);
          setReplyTarget(composerSnapshot.replyTarget);
          if (!rewindApplied) {
            setRewindTarget(composerSnapshot.rewindTarget);
            setRewindArtifactIds(composerSnapshot.rewindArtifactIds);
          }
        }
      }
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
    async (message: MobileMessage, answer: string, edits?: SpawnBotEdits) => {
      const targetBotId = botId;
      const targetGroupId = groupId;
      if ((!targetBotId && !targetGroupId) || !message.runId) return;
      try {
        await rpc("threads/answer", {
          ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
          runId: message.runId,
          messageId: message.id,
          answer,
          ...(edits ? { edits } : {}),
        });
      } catch (error) {
        // A refused edit may mean the card was answered meanwhile: reload so the sheet
        // can close on a card that is no longer answerable.
        if (edits && isCurrentTarget(targetBotId, targetGroupId)) {
          await refresh().catch(() => undefined);
        }
        throw error;
      }
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
    presentAttachSheet({
      title: t("Attach"),
      cancel: t("Cancel"),
      colorScheme,
      anchor: findNodeHandle(attachBubbleRef.current),
      onOpenChange: setAttachSheetOpen,
      options: [
        { text: t("Photo library"), onPress: () => void addAttachments(pickFromLibrary) },
        { text: t("Camera"), onPress: () => void addAttachments(takePhoto) },
        { text: t("File"), onPress: () => void addAttachments(pickDocuments) },
      ],
    });
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
  // The edit sheet lives only while its card can still be answered.
  useEffect(() => syncSpawnBotEdit(answerableAskMessageId), [answerableAskMessageId]);
  // Only the run's owner may edit a Create bot card; until this loads, nobody gets Edit.
  const [viewerUserId, setViewerUserId] = useState<string>();
  useEffect(() => {
    rpc<MobileMe>("me")
      .then((me) => setViewerUserId(me.userId))
      .catch(() => undefined);
  }, []);
  const listExtraData = useMemo(
    () => ({ answerableAskMessageId, viewerUserId }),
    [answerableAskMessageId, viewerUserId],
  );
  const runError = snap?.run?.status === "failed" ? (snap.run.error ?? null) : null;
  const liveMessages = useMemo(() => [...visibleMessages].reverse(), [visibleMessages]);
  liveMessagesRef.current = liveMessages;
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
  pinnedPageShowing.current = showPinnedPage;

  // MA-1: only a genuinely new message animates. "Load earlier" and the
  // pinned/jump page (its own ScrollView never reads `newMessageIds`) are
  // folded in as seeded — learned, but never reported as new — so returning
  // to the live list doesn't mistake them for arrivals either. Keyed on the
  // loaded snapshot's thread, not the route: the screen mounts (or switches
  // bot) before that thread's messages load, and seeding then would make
  // every message already there play its entrance.
  // Routine runs as log lines: a run keeps the message it then sent, and a
  // bot's consecutive runs with nothing between them share one line.
  const routineRoles = useMemo(() => foldRoutineRuns(visibleMessages), [visibleMessages]);
  // The time markers down the rendered rows. Routine lines carry their own
  // time, so between two of them a marker only says the day, when it changes.
  const { timeMarkers, previousRows } = useMemo(() => {
    const markers = new Map<string, string>();
    // The row drawn before each one: a folded run or a run's handoff is skipped.
    const before = new Map<string, MobileMessage>();
    let previousRow: MobileMessage | undefined;
    const labelOptions = {
      locale: dateLocaleForUi(),
      today: t("Today"),
      yesterday: t("Yesterday"),
    };
    let previous: { createdAt?: string; routine: boolean } | undefined;
    for (const message of visibleMessages) {
      const role = routineRoles.get(message.id);
      if (role?.kind === "hidden") continue;
      const routine = role?.kind === "run" || role?.kind === "group";
      const at = role?.kind === "group" ? role.runs[0]?.createdAt : message.createdAt;
      if (at) {
        const shows =
          routine && previous?.routine
            ? new Date(previous.createdAt ?? at).toDateString() !== new Date(at).toDateString()
            : showsTimeMarker(previous?.createdAt, at);
        if (shows) {
          markers.set(
            message.id,
            threadTimeMarkerLabel(at, { ...labelOptions, withTime: !routine }),
          );
        }
      }
      previous = { createdAt: message.createdAt ?? previous?.createdAt, routine };
      if (previousRow) before.set(message.id, previousRow);
      previousRow = message;
    }
    return { timeMarkers: markers, previousRows: before };
  }, [visibleMessages, routineRoles, t]);
  const newMessageIds = useMessageArrivals(snap?.threadId, visibleMessages, {
    seed: loadingOlderContent.current || showPinnedPage,
  });
  const arrivalStaggerMs = useMemo(
    () =>
      messageArrivalStaggerMs(
        visibleMessages
          .filter((message) => newMessageIds.has(message.id) && message.createdAt)
          .map((message) => ({ id: message.id, createdAt: message.createdAt! })),
      ),
    [visibleMessages, newMessageIds],
  );
  // 7d: a reaction pill pops on appearing or its count rising, never on mount alone.
  const poppedReactionKeys = useReactionPops(threadKey, reactionView.reactions);

  function performScroll(action: ThreadScrollAction) {
    if (!action || showPinnedPage) return;
    scroll.current?.scrollToOffset({
      offset: 0,
      animated: action === "smooth" && !reducedMotion,
    });
  }

  contentChanged.current = () => {
    const blocked = Boolean(
      jumpScrollTarget.current ||
        (pinnedAroundRef.current &&
          ((pinnedAroundRef.current.botId && pinnedAroundRef.current.botId === botId) ||
            (pinnedAroundRef.current.groupId && pinnedAroundRef.current.groupId === groupId))) ||
        expandedHistoryThread.current === snap?.threadId,
    );
    performScroll(scrollBehavior.current.onContentChanged(blocked, latestMessageId));
    setThreadScrollState(scrollBehavior.current.state());
  };

  function updateUserScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    listOffset.current = event.nativeEvent.contentOffset.y;
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
      // 7d: a success haptic for *my* reaction only, never for one received
      // in real time from someone else, and never on a failed call.
      successHaptic();
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return;
      setError(err instanceof Error ? err.message : t("Could not update reaction"));
    }
  }

  async function removeLinkPreview(message: MobileMessage) {
    const targetBotId = botId;
    const targetGroupId = groupId;
    try {
      await rpc("messages/removeLinkPreview", { messageId: message.id });
    } catch (err) {
      if (!isCurrentTarget(targetBotId, targetGroupId)) return;
      setError(err instanceof Error ? err.message : t("Try again."));
    }
  }

  function messageActionGroups(message: MobileMessage): MessageSheetAction[][] {
    const text = copyableMobileMessageText(message);
    return [
      [
        {
          name: "reply",
          text: t("Reply"),
          icon: { ios: "arrowshape.turn.up.left", android: "arrow-undo-outline" },
          onPress: () => setReplyTarget(message),
        },
        ...(message.role === "user"
          ? [
              {
                name: "rewind",
                text: "Edit and resend",
                icon: { ios: "pencil", android: "create-outline" } as const,
                onPress: () => startRewind(message),
              },
            ]
          : []),
        ...(message.role === "bot" && blockText(message)
          ? [
              {
                name: "speak",
                text: t("Speak message"),
                icon: { ios: "speaker.wave.2", android: "volume-high-outline" } as const,
                onPress: () => void speak(message),
              },
            ]
          : []),
      ],
      [
        ...(text
          ? [
              {
                name: "copy",
                text: t("Copy"),
                icon: { ios: "doc.on.doc", android: "copy-outline" } as const,
                onPress: () => void Clipboard.setStringAsync(text).catch(() => undefined),
              },
            ]
          : []),
        ...(linkPreviewCardOf(message)
          ? [
              {
                name: "removeLinkPreview",
                text: t("Remove preview"),
                icon: { ios: "eye.slash", android: "eye-off-outline" } as const,
                onPress: () => void removeLinkPreview(message),
              },
            ]
          : []),
      ],
    ];
  }

  /** The same actions for assistive tech, which has no long press. */
  function messageActions(message: MobileMessage) {
    const [primary = [], rest = []] = messageActionGroups(message);
    return [
      primary[0],
      ...(canReactToThreadMessage(message)
        ? [{ name: "react", text: t("React"), onPress: () => showMessageActions(message) }]
        : []),
      ...primary.slice(1),
      ...rest,
      ...(copyableMobileMessageText(message)
        ? [
            {
              name: "select",
              text: t("Select text"),
              onPress: () => showMessageActions(message, "text"),
            },
          ]
        : []),
    ].filter((action) => action !== undefined);
  }

  function showMessageActions(message: MobileMessage, mode: "actions" | "text" = "actions") {
    if (mode === "actions") selectionHaptic();
    const owner = `thread:${threadKey}`;
    messageSheetOwner.current = owner;
    openSheet(
      router,
      (close) => (
        <MessageActionsSheet
          initialMode={mode}
          reactions={
            canReactToThreadMessage(message)
              ? MESSAGE_REACTIONS.map((emoji) => ({
                  emoji,
                  onPress: () => void reactToMessage(message, emoji),
                }))
              : []
          }
          groups={messageActionGroups(message)}
          text={copyableMobileMessageText(message)}
          close={close}
        />
      ),
      { owner, background: tokens.popover },
    );
  }

  // One props object per message whose handlers reach the latest render, so
  // `MessageBubble` can skip re-rendering while the thread scrolls or the
  // composer changes. Rebuilt with the language: its labels are translated.
  const latestActions = useRef({ messageActions, showMessageActions });
  latestActions.current = { messageActions, showMessageActions };
  const actionPropsCache = useMemo(
    () => new WeakMap<MobileMessage, MessageActionProps>(),
    [locale],
  );
  function messageActionProps(message: MobileMessage): MessageActionProps {
    const cached = actionPropsCache.get(message);
    if (cached) return cached;
    const props: MessageActionProps = {
      onLongPress: () => latestActions.current.showMessageActions(message),
      accessibilityActions: messageActions(message).map((action) => ({
        name: action.name,
        label: action.text,
      })),
      onAccessibilityAction: (event) => {
        latestActions.current
          .messageActions(message)
          .find((action) => action.name === event.nativeEvent.actionName)
          ?.onPress();
      },
    };
    actionPropsCache.set(message, props);
    return props;
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

  /** Rule R's gap (design contract § Grouping): 0 between two consecutive
   * asides, 3 within a group, 14 otherwise (opening a new group, or the very
   * first rendered row). */
  function gapBeforeRow(
    message: MobileMessage,
    chrome: MessageChrome,
    previousMessage: MobileMessage | undefined,
  ): number {
    if (
      chrome === "aside" &&
      previousMessage &&
      isAsideOnlyMessage(visibleMessageBlocks(previousMessage.blocks, showSteps))
    ) {
      return 0;
    }
    // Routine lines stack like a log, with no gap between them.
    const routineLine = (candidate: MobileMessage | undefined) =>
      Boolean(candidate && routineRoles.has(candidate.id));
    if (routineLine(message) && routineLine(previousMessage)) return 0;
    return messageGroupsById.get(message.id)?.isFirstOfGroup === false
      ? WITHIN_GROUP_GAP
      : GROUP_GAP;
  }

  function renderMessageRow(
    message: MobileMessage,
    options?: { enableJump?: boolean; previousMessage?: MobileMessage },
  ) {
    const routineRole = routineRoles.get(message.id);
    // Drawn by another line: a folded routine run, or the message a run sent.
    if (routineRole?.kind === "hidden") return null;
    const actionProps = messageActionProps(message);
    const timeMarker = timeMarkers.get(message.id) ?? "";
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
    const group = messageGroupsById.get(message.id);
    // MA-1: never for a message present at thread open, "Load earlier", or
    // the jump/pinned page — `options.enableJump` is only ever passed by the
    // pinned ScrollView's own call site, so excluding it here is exactly
    // "never in the jump view".
    const isNew = Boolean(!options?.enableJump && newMessageIds.has(message.id));
    // 7g: swipe-to-reply is a bot *narration* bubble's gesture only — a
    // decision card, an ask, a routine/subagent card, a peer-message marker
    // or an attachment keep their existing behaviour untouched.
    const isNarrationBotBubble =
      chrome === "row" &&
      message.role === "bot" &&
      drawnBlocks.length > 0 &&
      !drawnBlocks.some((block) => CARD_ONLY_BLOCK_KINDS.has(block.kind));
    const replyPreviewNode =
      chrome === "row" && message.replyToMessageId
        ? messagesById.get(message.replyToMessageId)
        : undefined;
    // The preview card sits under the bubble, or takes its place when the message is only the
    // link. A message that is itself a card (ask, routine run, ...) never carries one.
    const previewCard = chrome === "row" ? linkPreviewCardOf(message) : undefined;
    const cardReplacesBubbleView = previewCard
      ? cardReplacesBubble(drawnBlocks, previewCard)
      : false;
    const bubble = (
      <MessageBubble
        botId={botId ?? snap?.members?.[0]?.botId ?? ""}
        groupId={groupId}
        message={message}
        botName={displayName}
        bots={mentionBots}
        members={snap?.members}
        replyPreview={replyPreviewNode}
        canAnswer={message.id === answerableAskMessageId}
        viewerUserId={viewerUserId}
        onAnswer={answerMessage}
        onOpenBot={openBot}
        onPreviewMarkdown={setMarkdownPreview}
        actionProps={actionProps}
        isNew={isNew}
        routineRole={routineRole}
        // The card shows the link, so the bubble does not repeat the line that is only that link.
        previewedUrl={previewCard && !cardReplacesBubbleView ? previewCard.url : undefined}
      />
    );
    const previewNode = previewCard ? (
      <MessageArrival
        isNew={isNew}
        enterDelayMs={message.role === "bot" ? (arrivalStaggerMs.get(message.id) ?? 0) : 0}
      >
        <LinkPreviewCard
          card={previewCard}
          target={groupId ? { groupId } : { botId: botId ?? snap?.members?.[0]?.botId ?? "" }}
          mono={message.role === "user" || !inGroup}
          align={message.role === "user" ? "end" : "start"}
          onLongPress={actionProps.onLongPress}
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        />
      </MessageArrival>
    ) : null;
    const withPreview = (content: ReactNode) =>
      previewNode ? (
        cardReplacesBubbleView ? (
          // The card takes the bubble's place, and the quote it carried stays above it.
          <View style={{ alignItems: message.role === "user" ? "flex-end" : "flex-start" }}>
            <ReplyQuote message={message} replyPreview={replyPreviewNode} />
            {previewNode}
          </View>
        ) : (
          <View style={{ gap: 4 }}>
            {content}
            {previewNode}
          </View>
        )
      ) : (
        content
      );
    return (
      <ThreadRowContext.Provider key={message.id} value={message.id}>
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
          style={{
            // A day marker between two routine lines still needs its air above.
            marginTop: Math.max(
              timeMarker ? GROUP_GAP : 0,
              gapBeforeRow(
                message,
                chrome,
                routineRoles.size ? previousRows.get(message.id) : options?.previousMessage,
              ),
            ),
          }}
        >
          {timeMarker ? (
            <Text
              style={{
                alignSelf: "center",
                marginBottom: GROUP_GAP,
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
                    still
                  />
                }
                author={author.name}
                showAuthor={inGroup && (group?.isFirstOfGroup ?? true)}
                showAvatar={inGroup && (group?.isLastOfGroup ?? true)}
                mono={!inGroup}
              >
                {withPreview(
                  isNarrationBotBubble ? (
                    <AnimatedMessageBubble
                      variant="bot"
                      isNew={isNew}
                      enterDelayMs={arrivalStaggerMs.get(message.id) ?? 0}
                      // A table scrolls sideways inside the bubble; a rightward drag
                      // there must move the table, not start a reply.
                      enableSwipeReply={
                        !options?.enableJump &&
                        !message.blocks.some(
                          (block) => block.kind === "text" && hasMarkdownTable(block.text),
                        )
                      }
                      onLongPress={actionProps.onLongPress!}
                      onSwipeReply={() => setReplyTarget(message)}
                      accessibilityActions={actionProps.accessibilityActions}
                      onAccessibilityAction={actionProps.onAccessibilityAction}
                    >
                      {bubble}
                    </AnimatedMessageBubble>
                  ) : (
                    <MessageArrival
                      isNew={isNew}
                      enterDelayMs={arrivalStaggerMs.get(message.id) ?? 0}
                    >
                      <Pressable accessible={false} onLongPress={actionProps.onLongPress}>
                        {bubble}
                      </Pressable>
                    </MessageArrival>
                  ),
                )}
              </MessageRow>
            ) : chrome === "row" && message.role === "user" ? (
              withPreview(
                <AnimatedMessageBubble
                  variant="user"
                  isNew={isNew}
                  onLongPress={actionProps.onLongPress!}
                  accessibilityActions={actionProps.accessibilityActions}
                  onAccessibilityAction={actionProps.onAccessibilityAction}
                >
                  {bubble}
                </AnimatedMessageBubble>,
              )
            ) : chrome === "row" ? (
              withPreview(
                <Pressable accessible={false} onLongPress={actionProps.onLongPress}>
                  {bubble}
                </Pressable>,
              )
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
                  marginStart:
                    chrome === "row" && message.role === "bot" && inGroup ? FRAMED_INDENT : 0,
                  justifyContent: message.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                {[...messageReactions].map(([emoji, count]) => (
                  <ReactionPill
                    key={emoji}
                    emoji={emoji}
                    count={count}
                    pop={poppedReactionKeys.has(reactionPopKey(message.id, emoji))}
                  />
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </ThreadRowContext.Provider>
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
  const workingName =
    workingBotsForLine.length === 1
      ? (workingBotsForLine[0]?.name ?? t("Agent"))
      : t("{count} agents working", { count: workingBotsForLine.length });
  const workingAvatar =
    workingBotsForLine.length === 1 ? (
      <BotAvatar
        color={workingBotsForLine[0]?.color ?? tokens.mutedForeground}
        identity={workingBotsForLine[0]?.botId}
        shapeSeed={workingBotsForLine[0]?.shapeSeed}
        size={sizes.message}
        status="running"
      />
    ) : (
      <GroupAvatar members={workingBotsForLine} size={sizes.message} />
    );
  // The typing bubble (design contract decision D1-b): no elapsed clock, no
  // generic "is working…" copy — three pulsing dots, or, for a single bot
  // whose activity is known, that activity in chatoyant text instead.
  //
  // 7c: it exits with a 120ms fade rather than snapping away the instant work
  // stops. `footerVisible` keeps the row mounted for that fade; `lastWorking`
  // remembers the avatar/name/activity to keep drawing while `workingActive`
  // has already gone false but the fade hasn't finished.
  const workingActive = workingBotsForLine.length > 0;
  const [footerVisible, setFooterVisible] = useState(workingActive);
  const footerOpacity = useSharedValue(workingActive ? 1 : 0);
  const shownActivityLabel = workingBotsForLine.length === 1 ? activityLabel : undefined;
  const lastWorking = useRef({
    avatar: workingAvatar,
    name: workingName,
    activityLabel: shownActivityLabel,
  });
  if (workingActive) {
    lastWorking.current = {
      avatar: workingAvatar,
      name: workingName,
      activityLabel: shownActivityLabel,
    };
  }
  useEffect(() => {
    if (workingActive) {
      setFooterVisible(true);
      footerOpacity.value = 1;
      return;
    }
    if (!footerVisible) return;
    footerOpacity.value = withTiming(0, { duration: CHAT_MOTION.typingExitMs }, (finished) => {
      if (finished) runOnJS(setFooterVisible)(false);
    });
    // footerVisible is read, not a trigger: re-running this branch every time
    // it flips would cancel the very fade it just started.
  }, [workingActive]);
  const footerAnimatedStyle = useAnimatedStyle(() => ({ opacity: footerOpacity.value }));
  const workingFooter = footerVisible ? (
    <Animated.View
      style={[{ marginTop: GROUP_GAP }, footerAnimatedStyle]}
      // The typing bubble grows the thread without a new message; keep it in
      // view above the composer when the reader is at the latest messages.
      onLayout={() => performScroll(scrollBehavior.current.onTailChanged())}
    >
      <MessageRow
        avatar={
          <BuzzingAvatar>
            {workingActive ? workingAvatar : lastWorking.current.avatar}
          </BuzzingAvatar>
        }
        author={workingActive ? workingName : lastWorking.current.name}
        showAuthor={inGroup}
        showAvatar={inGroup}
        mono={!inGroup}
      >
        <TypingBubble
          activityLabel={workingActive ? shownActivityLabel : lastWorking.current.activityLabel}
        />
      </MessageRow>
    </Animated.View>
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
    <TableActionsProvider value={tableActions}>
      <ThreadGrowthContext.Provider value={threadGrowth}>
        <KeyboardAvoidingView
          behavior="height"
          keyboardVerticalOffset={headerHeight}
          style={{
            flex: 1,
            backgroundColor: tokens.background,
            paddingHorizontal: 14,
          }}
        >
          {error ? (
            <Text style={{ color: tokens.mutedForeground, marginTop: 12 }}>{error}</Text>
          ) : null}
          {runError ? (
            <Text style={{ color: tokens.destructive, marginTop: 12 }}>{runError}</Text>
          ) : null}
          <View style={{ flex: 1, position: "relative" }}>
            {showPinnedPage ? (
              <ScrollView
                key={jumpScrollTarget.current ?? pinnedTarget?.messageId ?? threadKey}
                ref={pinnedScroll}
                style={{ flex: 1, marginTop: 8 }}
                maintainVisibleContentPosition={KEEP_VISIBLE_POSITION}
                keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                keyboardShouldPersistTaps="handled"
              >
                {loadEarlierControl}
                {visibleMessages.map((message, index) =>
                  renderMessageRow(message, {
                    enableJump: true,
                    previousMessage: visibleMessages[index - 1],
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
                extraData={listExtraData}
                style={{ flex: 1, marginTop: 8 }}
                maintainVisibleContentPosition={keptPosition}
                scrollEventThrottle={16}
                // dragging the thread down dismisses the keyboard following the
                // finger on iOS (Android has no true interactive equivalent, so it
                // dismisses on the drag instead); a tap that lands on a row's own
                // control still fires that control instead of just closing the keyboard.
                keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                keyboardShouldPersistTaps="handled"
                onScrollBeginDrag={() => {
                  userDragging.current = true;
                }}
                onScroll={(event) => {
                  listOffset.current = event.nativeEvent.contentOffset.y;
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
                  // A row the person just opened is holding its place: replay
                  // the change once the hold ends, so it isn't lost.
                  const held = holdingRowUntil.current - Date.now();
                  clearTimeout(heldContentChange.current);
                  if (held > 0) {
                    heldContentChange.current = setTimeout(() => contentChanged.current(), held);
                    return;
                  }
                  contentChanged.current();
                }}
                ListFooterComponent={loadEarlierControl}
                ListHeaderComponent={workingFooter}
                renderItem={({ item, index }) =>
                  renderMessageRow(item, { previousMessage: liveMessages[index + 1] })
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
                  boxShadow: shadowsForAppearance(colorScheme).floating,
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
              // 8 px above the keyboard when it's open, 8 px above the
              // safe area otherwise (floored so devices without a safe-area inset,
              // e.g. Android's 3-button nav, still keep a little breathing room).
              paddingBottom: keyboardVisible ? 8 : Math.max(insets.bottom + 8, 20),
            }}
          >
            {replyTarget ? (
              // 7g: rises in on every appearance — the action sheet's "Reply" and
              // a bubble swipe past the threshold both just set `replyTarget`.
              <Animated.View
                entering={
                  reducedMotion
                    ? FadeIn.duration(CHAT_MOTION.reducedFadeMs)
                    : FadeInDown.duration(CHAT_MOTION.replyPreviewMs)
                }
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
                <Pressable
                  accessibilityLabel={t("Cancel reply")}
                  onPress={() => setReplyTarget(null)}
                >
                  <Text style={{ color: tokens.mutedForeground }}>✕</Text>
                </Pressable>
              </Animated.View>
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
                      <Text style={{ color: tokens.foreground, fontSize: 14 }}>
                        @{mention.name}
                      </Text>
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
                    <Text style={{ color: tokens.foreground, fontSize: 14 }}>
                      {t(action.label)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View
              style={{
                marginTop: 16,
                // 12 px side margins — the screen already gives the thread
                // column 20 px (`paddingHorizontal` above), so this row claims
                // back 8 of those to land on 12.
                marginHorizontal: -8,
                flexDirection: "row",
                alignItems: "flex-end",
                gap: 8,
              }}
            >
              {dictation.dictating ? null : (
                <ComposerAttachBubble
                  ref={attachBubbleRef}
                  open={attachSheetOpen}
                  focused={composerFocused}
                  onPress={showAttachMenu}
                />
              )}
              <ComposerShell
                style={{ flex: 1 }}
                state={canSend ? "typing" : "idle"}
                focused={composerFocused}
                dictating={dictation.dictating}
                dictationVolume={dictation.volume}
                attachments={
                  activePendingAttachments.length || linkPreview.view.status !== "idle" ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      // The link preview takes the row's width, which a horizontal scroll view
                      // never imposes on its children: measure it once and pass it down.
                      onLayout={(event) => setAttachmentsRowWidth(event.nativeEvent.layout.width)}
                    >
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        {activePendingAttachments.map((attachment) => (
                          <ComposerAttachment
                            key={attachment.id}
                            name={attachment.name}
                            previewUri={attachment.previewUri}
                            disabled={dictation.dictating}
                            onRemove={() =>
                              setPendingAttachments((current) =>
                                current.filter((item) => item.id !== attachment.id),
                              )
                            }
                          />
                        ))}
                        {linkPreview.view.status === "idle" ? null : (
                          <ComposerLinkPreview
                            width={attachmentsRowWidth}
                            view={linkPreview.view}
                            disabled={dictation.dictating}
                            onRemove={() => linkPreview.controller.remove()}
                          />
                        )}
                      </View>
                    </ScrollView>
                  ) : undefined
                }
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
                            disabled={dictation.dictating}
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
                          style={[composerChip, { backgroundColor: tokens.mentionChip }]}
                        >
                          <MentionChipIcon mention={mention} />
                          <Text
                            numberOfLines={1}
                            style={{
                              color: tokens.mentionChipForeground,
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
                            disabled={dictation.dictating}
                            onPress={() =>
                              setSelectedMentions((current) =>
                                current.filter(
                                  (selected) =>
                                    mentionChipKey(selected) !== mentionChipKey(mention),
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
                  dictation.dictating ? undefined : (
                    <>
                      {dictation.available ? (
                        <ComposerButton
                          label={t("Dictate")}
                          haptic="none"
                          variant="bare"
                          disabled={sending}
                          onPress={dictation.start}
                        >
                          <NativeSymbol
                            ios="mic"
                            android="mic-outline"
                            size={20}
                            color={tokens.foreground}
                          />
                        </ComposerButton>
                      ) : null}
                      {canSend ? (
                        <ComposerButton
                          label={t("Send")}
                          haptic="send"
                          arrive
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
                      ) : null}
                      {working ? (
                        <ComposerButton
                          label={t("Stop")}
                          haptic="commit"
                          disabled={sending}
                          contour={
                            <StopContour size={sizes.composerAction + 4} color={stopContourColor} />
                          }
                          onPress={() => void stop()}
                        >
                          <NativeSymbol
                            ios="stop.fill"
                            android="stop"
                            size={13}
                            color={tokens.primaryForeground}
                          />
                        </ComposerButton>
                      ) : null}
                    </>
                  )
                }
                dictationCancel={
                  dictation.dictating ? (
                    <ComposerButton
                      label={t("Cancel dictation")}
                      haptic="none"
                      variant="bare"
                      onPress={dictation.cancel}
                    >
                      <NativeSymbol
                        ios="xmark"
                        android="close"
                        size={16}
                        color={tokens.foreground}
                      />
                    </ComposerButton>
                  ) : undefined
                }
                dictationConfirm={
                  dictation.dictating ? (
                    <>
                      {working ? (
                        <ComposerButton
                          label={t("Stop")}
                          haptic="commit"
                          disabled={sending}
                          contour={
                            <StopContour size={sizes.composerAction + 4} color={stopContourColor} />
                          }
                          onPress={() => void stop()}
                        >
                          <NativeSymbol
                            ios="stop.fill"
                            android="stop"
                            size={13}
                            color={tokens.primaryForeground}
                          />
                        </ComposerButton>
                      ) : null}
                      <ComposerButton
                        label={t("Insert dictation")}
                        haptic="none"
                        onPress={insertDictation}
                      >
                        <NativeSymbol
                          ios="checkmark"
                          android="checkmark"
                          size={16}
                          color={tokens.primaryForeground}
                        />
                      </ComposerButton>
                    </>
                  ) : undefined
                }
              >
                {dictation.dictating ? (
                  <DictationPreview
                    prefix={dictation.previewPrefix}
                    finalText={dictation.finalText}
                    interimText={dictation.interimText}
                  />
                ) : (
                  <TextInput
                    ref={textInputRef}
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
                    placeholderTextColor={tokens.mutedForeground}
                    selectionColor={tokens.foreground}
                    cursorColor={tokens.foreground}
                    keyboardAppearance={colorScheme}
                    multiline
                    textAlignVertical="center"
                    blurOnSubmit={false}
                    onFocus={() => setComposerFocused(true)}
                    onBlur={() => setComposerFocused(false)}
                    style={{
                      color: tokens.foreground,
                      // 5 lines max, then the field scrolls internally. iOS's
                      // multiline box is border-box (Yoga), so its 11 pt of
                      // vertical padding below counts against this height too —
                      // without adding it back, only about 4 lines actually fit.
                      maxHeight: Platform.OS === "ios" ? 5 * 22 + 2 * 11 : 110,
                      writingDirection: "auto",
                      ...nativeTextStyle("composer"),
                      // A multiline iOS field puts all of a line height's extra
                      // leading above the glyphs, so the text sat low in the
                      // capsule; the font's own line box centres it. The row is
                      // `sizes.composerTarget` (44) tall, and one composer line is
                      // 22, so 11 on each side centres it there.
                      ...(Platform.OS === "ios"
                        ? { lineHeight: undefined, paddingVertical: 11 }
                        : { paddingVertical: 4 }),
                    }}
                  />
                )}
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
          {tablePreview ? (
            <TablePreview table={tablePreview} onClose={() => setTablePreview(null)} />
          ) : null}
        </KeyboardAvoidingView>
      </ThreadGrowthContext.Provider>
    </TableActionsProvider>
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

/** The send arrow pivots in like the web's `animate-arrive`, but rotating —
 * -90° to 0°, scaling up from .6, fading in — over `motion.pivot`. */
const COMPOSER_PIVOT = new Keyframe({
  0: { opacity: 0, transform: [{ rotate: "-90deg" }, { scale: 0.6 }] },
  100: {
    opacity: 1,
    transform: [{ rotate: "0deg" }, { scale: 1 }],
    easing: Easing.bezier(0.32, 0.72, 0, 1),
  },
}).duration(motion.pivot);

/** A composer action disc: a `sizes.composerTarget` (44 pt) touch target
 * around a `sizes.composerAction` (36 pt) `primary` disc — settles to scale
 * .9 while pressed (skipped under reduced motion), the web's `rk-press-round`. */
function ComposerButton({
  label,
  onPress,
  disabled,
  arrive = false,
  haptic,
  contour,
  variant = "disc",
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Animate in with a pivot on mount — the send arrow appearing with the first character. */
  arrive?: boolean;
  /** "none" for a dictation control that already fires its own haptic (mic tap, ✓ insert) or has none (×). */
  haptic: "send" | "commit" | "none";
  /** The Stop button's animated ring, drawn just outside the disc. */
  contour?: ReactNode;
  /** "bare" draws just the icon at full size in the touch target, no ink
   * disc — dictation's × (the design has no disc behind Cancel,
   * unlike Send/Stop/✓). */
  variant?: "disc" | "bare";
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  const reducedMotion = useReducedMotion();
  const pressed = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.1 }],
  }));
  const press = (down: boolean) => {
    if (reducedMotion) return;
    pressed.value = withTiming(down ? 1 : 0, {
      duration: motion.press,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
    });
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        if (haptic === "send") sendHaptic();
        else if (haptic === "commit") commitHaptic();
        onPress();
      }}
      onPressIn={() => press(true)}
      onPressOut={() => press(false)}
      style={{
        width: sizes.composerTarget,
        height: sizes.composerTarget,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {contour}
      <Animated.View
        entering={arrive && !reducedMotion ? COMPOSER_PIVOT : undefined}
        style={[
          variant === "disc"
            ? {
                width: sizes.composerAction,
                height: sizes.composerAction,
                borderRadius: radii.pill,
                backgroundColor: tokens.primary,
                alignItems: "center",
                justifyContent: "center",
              }
            : { alignItems: "center", justifyContent: "center" },
          pressStyle,
        ]}
      >
        {children}
      </Animated.View>
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
      still
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

type MessageActionProps = Pick<TextProps, "accessibilityActions" | "onAccessibilityAction"> & {
  // Plain `() => void`, not `TextProps["onLongPress"]`'s `(event) => void`:
  // every implementation ignores the event, and this shape assigns cleanly
  // both to a `Pressable`'s `onLongPress` (a card's untouched wrapper) and to
  // `AnimatedMessageBubble`'s RNGH-driven `onLongPress` (a plain callback).
  onLongPress: () => void;
};

const MessageBubble = memo(function MessageBubble({
  botId,
  botName,
  bots,
  groupId,
  message,
  members,
  replyPreview,
  canAnswer,
  viewerUserId,
  onAnswer,
  onOpenBot,
  onPreviewMarkdown,
  actionProps,
  isNew,
  routineRole,
  previewedUrl,
}: {
  botId: string;
  botName?: string;
  bots: MobileBot[];
  groupId?: string;
  message: MobileMessage;
  members?: MobileSnapshot["members"];
  replyPreview?: MobileMessage;
  canAnswer: boolean;
  viewerUserId?: string;
  onAnswer: (message: MobileMessage, answer: string, edits?: SpawnBotEdits) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  actionProps: MessageActionProps;
  /** 7f: a new "Messaged / Message from" marker makes its two bloubs glance
   * at each other once. Never for one already on screen at thread open. */
  isNew: boolean;
  /** How a routine run renders once runs are folded (a line, a group). */
  routineRole?: RoutineRowRole;
  /** The link its card shows: a line that is only this link is left out of the text drawn. */
  previewedUrl?: string;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const showSteps = useDisplayAgentSteps();
  const artifactTarget: MobileArtifactTarget = groupId ? { groupId } : { botId };
  const cardBotId = message.botId ?? botId;
  // Mono-bot grammar (design contract §3b): the narration bubble caps at 82%
  // of the thread instead of 88% of the content column.
  const mono = !groupId;
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
    return <HandoffDivider>{handoff.text ? `${label} · ${handoff.text}` : label}</HandoffDivider>;
  }
  const openPeerMessages = (peerBotId: string | undefined, peer: string | undefined) =>
    router.push({
      pathname: "/peer-messages",
      params: {
        botId: cardBotId,
        botName: memberName(members, cardBotId) ?? botName ?? "",
        botColor: botColorOf(cardBotId),
        botShapeSeed: avatarOf(cardBotId).shapeSeed?.toString() ?? "",
        peerBotId,
        peerBotName: peer ?? "",
        peerColor: botColorOf(peerBotId),
        peerShapeSeed: avatarOf(peerBotId).shapeSeed?.toString() ?? "",
      },
    });
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
    // 7f: a brand-new marker's two bloubs glance at each other once — the
    // first item (rendered on the left by `StackedAvatars`) looks right,
    // toward the second, which looks left, toward it.
    const pairItems = pair.map((id, index) => ({
      ...avatarOf(id),
      ...(isNew ? { glance: index === 0 ? ("right" as const) : ("left" as const) } : {}),
    }));
    // Compact receipt only: peer bodies stay out of the human thread; the full
    // view-only exchange opens on its own screen.
    return (
      <Interstitial
        accessibilityLabel={label}
        avatars={<StackedAvatars items={pairItems} size={sizes.interstitial} still />}
        hitSlop={{ top: 5, bottom: 5, left: 8, right: 8 }}
        onPress={() => openPeerMessages(peerBotId, peer)}
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
    const handoffFor = (item: RoutineGroupRun): RoutineHandoff | undefined => {
      const sent = item.sentTo;
      if (!sent) return undefined;
      return {
        receipt: <BotAvatar {...avatarOf(sent.toBotId)} size={sizes.receipt} still />,
        avatars: (
          <StackedAvatars
            items={[avatarOf(cardBotId), avatarOf(sent.toBotId)]}
            size={sizes.interstitial}
            still
          />
        ),
        label: t("Messaged {peer}", { peer: sent.toBotName ?? t("Bot") }),
        onPress: () => openPeerMessages(sent.toBotId, sent.toBotName),
      };
    };
    if (routineRole?.kind === "group") {
      return (
        <RoutineGroup runs={routineRole.runs} handoffFor={handoffFor} actionProps={actionProps} />
      );
    }
    const item =
      routineRole?.kind === "run"
        ? routineRole.run
        : { messageId: message.id, createdAt: message.createdAt, run: routineRun, latest: true };
    return <RoutineRunLine item={item} handoff={handoffFor(item)} actionProps={actionProps} />;
  }
  const special = message.blocks.find(
    (block) => block.kind === "subagent" || block.kind === "child_bot",
  );
  if (special?.kind === "subagent") {
    const running = special.status === "running";
    const failed = special.status === "failed";
    const body = special.result || special.progress;
    return (
      <TaskCard
        title={special.name || t("subagent")}
        state={running ? "running" : failed ? "failed" : "done"}
        meta={special.task}
        body={body}
        streaming={running}
        actionProps={actionProps}
      />
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
    // A routine card, proposed by the bot or confirming one set up, shows what it creates
    // instead of the plain-text detail.
    const routineCard = approval ? askBlock.routine : undefined;
    // The row above already names the bot; the card only repeats itself for a
    // consequential approval, name-less. A question with fixed options or a
    // routine card opens with no header.
    const header = approval && !routineCard ? { who: t("Needs your call") } : undefined;
    const created = askBlock.created;
    const routineSettled = (): ReactNode => {
      if (!created) {
        switch (routineCardSettlement(askBlock)) {
          case "failed":
            return t("Couldn't create");
          case "not_now":
            return t("Not now");
          case "creating":
            return t("Creating…");
          default:
            return t("Answered");
        }
      }
      return (
        <Pressable
          accessibilityRole="link"
          onPress={() =>
            router.push({
              pathname: "/routine",
              params: {
                botId: cardBotId,
                botName: memberName(members, cardBotId) ?? botName ?? "",
                routineId: created.id,
              },
            })
          }
          style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}
        >
          <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
            {askBlock.confirms === "updated" ? t("Routine updated") : t("Routine created")} ·{" "}
            <Text style={{ color: tokens.foreground, fontWeight: "600" }}>{created.label}</Text>
          </Text>
          <NativeSymbol
            ios="chevron.right"
            android="chevron-forward"
            size={11}
            color={tokens.mutedForeground}
          />
        </Pressable>
      );
    };
    const answeredLine =
      askBlock.status === "answered"
        ? routineCard
          ? routineSettled()
          : formatApprovalAnswer(askBlock.answer, askBlock.actions, approval)
        : !canAnswer
          ? t("No longer active")
          : undefined;
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <FramedBlock
          header={header ? { ...header, dot: answeredLine === undefined } : undefined}
          question={<Text {...actionProps}>{askBlock.text}</Text>}
          consequence={routineCard ? undefined : askBlock.detail}
          answered={answeredLine}
          actions={
            answeredLine === undefined ? (
              <AskActions
                actions={askBlock.actions}
                approval={approval}
                consequential={!routineCard}
                allowFreeText={!approval}
                accessibilityActions={actionProps.accessibilityActions}
                onAccessibilityAction={actionProps.onAccessibilityAction}
                onAnswer={(answer) => onAnswer(message, answer)}
                onEdit={
                  askBlock.spawnBot &&
                  canAnswer &&
                  canEditSpawnBotCard(askBlock.spawnBot, viewerUserId)
                    ? () =>
                        openSpawnBotEdit(router, {
                          messageId: message.id,
                          spawnBot: askBlock.spawnBot!,
                          submit: (edits) => onAnswer(message, "allow", edits),
                        })
                    : undefined
                }
              />
            ) : undefined
          }
        >
          {routineCard && answeredLine === undefined ? (
            <RoutineCardPreview routine={routineCard} />
          ) : null}
        </FramedBlock>
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
  const shownBlocks = previewedUrl
    ? blocksWithoutPreviewedLinkLine(message.blocks, previewedUrl)
    : message.blocks;
  const caption = shownBlocks
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
  const segments = messagePresentationSegments(shownBlocks);
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
          mono={mono}
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
/** A headline that only restates the routine's name ("📭 Check inbox" for
 * `check-inbox-midi`) adds nothing under it. */
function headlineRepeatsName(headline: string, name: string): boolean {
  const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const short = letters(headline);
  return short.length > 0 && letters(name).includes(short);
}

type TaskCardState = "running" | "done" | "failed" | "cancelled";

/** The run's state as one symbol: the shape tells it apart without colour, the colour only confirms. */
const ROUTINE_STATE_SYMBOL = {
  queued: { ios: "clock", android: "time-outline" },
  running: { ios: "circle.dotted", android: "ellipse-outline" },
  completed: { ios: "checkmark.circle.fill", android: "checkmark-circle" },
  failed: { ios: "xmark.circle.fill", android: "close-circle" },
  cancelled: { ios: "stop.circle", android: "stop-circle-outline" },
} as const;

/** How far the last lines of a cut preview fade into its host. */
const PREVIEW_FADE_HEIGHT = 56;
/** A cut routine report: eight lines of the 23 pt body. */
const REPORT_PREVIEW_HEIGHT = 8 * 23;
/** A cut task result: five lines. */
const TASK_PREVIEW_HEIGHT = 5 * 23;
/** Past this many runs, a group opens in a sheet instead of in place. */
const GROUP_INLINE_MAX = 8;

/**
 * A row's content opening under its header (a routine's report, a group's
 * runs), its height animated on the UI thread. The header stays where the
 * person tapped it: while it moves, the list keeps the row above in place
 * (see `ThreadGrowthContext`). At rest the content takes its own height, so a
 * row opening inside it flows through.
 */
function Expandable({
  open,
  fromTap,
  children,
}: {
  open: boolean;
  /** Set by the header's tap: only a change the person asked for is animated. */
  fromTap: { current: boolean };
  children: ReactNode;
}) {
  const growth = useContext(ThreadGrowthContext);
  const rowId = useContext(ThreadRowContext);
  const parentHeight = useContext(ExpandableHeightContext);
  const reducedMotion = useChatReducedMotion();
  const [mounted, setMounted] = useState(open);
  // Always a number: the content is laid out on its own (a clipped parent
  // would squeeze it), and the box follows it.
  const height = useSharedValue(0);
  const contentHeight = useRef(0);
  const animating = useRef(open);

  // A box opening inside this one grows this one by as much, in the same
  // frame, so nothing below it is cut while it moves.
  useAnimatedReaction(
    () => height.value,
    (current, previous) => {
      if (previous == null || !parentHeight) return;
      parentHeight.value = parentHeight.value + (current - previous);
    },
  );

  const settle = (closed: boolean) => {
    fromTap.current = false;
    animating.current = false;
    if (closed) {
      // Measured afresh on the next opening: kept, the same height read as
      // "nothing changed" and the box stayed shut.
      contentHeight.current = 0;
      setMounted(false);
    }
  };

  const animateTo = (target: number, closing: boolean) => {
    const moves = fromTap.current;
    if (moves) growth?.hold(rowId);
    animating.current = true;
    const duration = moves && !reducedMotion ? 240 : 0;
    runOnUI(() => {
      "worklet";
      height.value = withTiming(
        target,
        { duration, easing: CHAT_MOTION.botEnterEasing },
        (finished) => {
          if (finished) runOnJS(settle)(closing);
        },
      );
    })();
  };

  useEffect(() => {
    if (open) {
      if (!mounted) {
        animating.current = true;
        setMounted(true);
      }
    } else if (mounted) {
      animateTo(0, true);
    }
  }, [open]);

  const style = useAnimatedStyle(() => ({ height: height.value }));
  if (!mounted) return null;
  return (
    <Animated.View style={[{ overflow: "hidden" }, style]}>
      <ExpandableHeightContext.Provider value={height}>
        <View
          style={{ position: "absolute", top: 0, left: 0, right: 0 }}
          onLayout={(event) => {
            const next = event.nativeEvent.layout.height;
            if (Math.abs(next - contentHeight.current) < 1) return;
            contentHeight.current = next;
            if (!open) return;
            // Opening, or the content settling while it opens: follow it.
            if (animating.current) animateTo(next, false);
            else if (Math.abs(height.value - next) >= 1) height.value = next;
          }}
        >
          {children}
        </View>
      </ExpandableHeightContext.Provider>
    </Animated.View>
  );
}

/**
 * Content cut to `maxHeight` when it runs longer: its last lines fade into
 * the host and a round expand badge sits on the fade, bottom right (Photos,
 * Maps). The badge only marks it; the whole preview is the target and opens
 * the rest. Content that fits renders as is.
 */
function ClippedPreview({
  maxHeight,
  fadeColor,
  onOpen,
  accessibilityLabel,
  children,
}: {
  maxHeight: number;
  fadeColor: string;
  onOpen: () => void;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const reducedMotion = useChatReducedMotion();
  const [height, setHeight] = useState(0);
  // Only worth cutting when it hides a few lines, not the last one.
  const capped = height > maxHeight + 3 * 23;
  // The content is measured outside the flow, so the row takes its final
  // height at once: laid out in full first, then cut, it grew and shrank in
  // one frame and the thread jumped. The last paragraph's bottom margin (9)
  // is the host's own end.
  const body = (
    <View
      style={{ position: "absolute", top: 0, left: 0, right: 0 }}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      {children}
    </View>
  );
  if (!capped) {
    return <View style={{ height: Math.max(0, height - 9), overflow: "hidden" }}>{body}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={t("Opens in full")}
      onPress={onOpen}
      unstable_pressDelay={130}
      style={{ height: maxHeight, overflow: "hidden" }}
    >
      {({ pressed }) => (
        <>
          {/* A cut in the middle of a line is laid out outside the flow: a height
              cap on the text itself made iOS stop wrapping. */}
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {body}
          </View>
          <Svg
            pointerEvents="none"
            width="100%"
            height={PREVIEW_FADE_HEIGHT}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          >
            <Defs>
              <LinearGradient id="preview-fade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={fadeColor} stopOpacity={0} />
                <Stop offset="0.6" stopColor={fadeColor} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height={PREVIEW_FADE_HEIGHT} fill="url(#preview-fade)" />
          </Svg>
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              right: 8,
              bottom: 8,
              width: sizes.hoverIcon,
              height: sizes.hoverIcon,
              borderRadius: sizes.hoverIcon / 2,
              borderWidth: 1,
              borderColor: tokens.outline,
              backgroundColor: pressed ? tokens.surface : tokens.secondary,
              alignItems: "center",
              justifyContent: "center",
              transform: [{ scale: pressed && !reducedMotion ? 0.94 : 1 }],
            }}
          >
            <NativeSymbol
              ios="arrow.up.left.and.arrow.down.right"
              android="expand-outline"
              size={13}
              weight="semibold"
              color={tokens.foreground}
            />
          </View>
        </>
      )}
    </Pressable>
  );
}

/** The bot a run then messaged, drawn by the run: a receipt at rest, the centred line when open. */
interface RoutineHandoff {
  receipt: ReactNode;
  avatars: ReactNode;
  label: string;
  onPress: () => void;
}

/** How long a page sheet takes to slide away before the next screen can push. */
const SHEET_DISMISS_MS = 350;

/** A handoff tapped inside a sheet: the sheet closes, then the bots' exchange opens. */
function handoffFromSheet(handoff: RoutineHandoff, close: () => void): RoutineHandoff {
  return {
    ...handoff,
    onPress: () => {
      close();
      setTimeout(handoff.onPress, SHEET_DISMISS_MS);
    },
  };
}

function routineTime(createdAt: string | undefined, withDay: boolean): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const locale = dateLocaleForUi();
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return withDay ? `${date.toLocaleDateString(locale, { weekday: "short" })} ${time}` : time;
}

/** A group's span: its hours on one day, its days across several ("Mon – Wed", "Sep 22 – 28"). */
function routineRange(first: string | undefined, last: string | undefined): string {
  if (!first || !last) return "";
  if (sameLocalDay(first, last))
    return `${routineTime(first, false)} – ${routineTime(last, false)}`;
  const locale = dateLocaleForUi();
  const start = new Date(first);
  const end = new Date(last);
  const overAWeek = end.getTime() - start.getTime() > 6 * 86_400_000;
  const day = (date: Date) =>
    overAWeek
      ? date.toLocaleDateString(locale, { month: "short", day: "numeric" })
      : date.toLocaleDateString(locale, { weekday: "short" });
  return `${day(start)} – ${day(end)}`;
}

function sameLocalDay(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return true;
  return new Date(left).toDateString() === new Date(right).toDateString();
}

/**
 * A routine run as a log line, not a card: status symbol, name, time, status
 * word, then fixed receipt, bell and disclosure slots so the columns line up
 * down a run of routines. Opening it shows the report under a hairline rail
 * (cut long reports open whole in a sheet) and, centred as every exchange
 * between bots is, the message it then sent. A failed run and a subscribed
 * one open on their report.
 */
function RoutineRunLine({
  item,
  handoff,
  actionProps,
  nested = false,
  withDay = false,
}: {
  item: RoutineGroupRun;
  handoff?: RoutineHandoff;
  actionProps: MessageActionProps;
  /** A line inside an open group: smaller symbol, no own long press. */
  nested?: boolean;
  withDay?: boolean;
}) {
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const block = item.run;
  const headline =
    block.headline && !headlineRepeatsName(block.headline, block.routineName)
      ? block.headline
      : undefined;
  // The headline is the digest's first line; alone, it is the whole report.
  const digest = block.digest?.trim() || headline;
  const subscribed = Boolean(block.notify);
  const failed = block.state === "failed";
  const opens = Boolean(digest || handoff);
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  // Only a routine's latest run opens on its own (failed, or subscribed):
  // older ones stay folded so a thread of past failures is not a wall of reports.
  const expanded =
    opens && (manualExpanded ?? Boolean(digest && item.latest && (subscribed || failed)));
  const fromTap = useRef(false);
  // At accessibility text sizes the time and status move under the name.
  const stacked = PixelRatio.getFontScale() > 1.35;
  const symbolColor =
    block.state === "completed"
      ? tokens.success
      : failed
        ? tokens.destructive
        : tokens.mutedForeground;
  const statusLabel =
    block.state === "queued"
      ? t("Queued")
      : block.state === "running"
        ? t("Running")
        : block.state === "completed"
          ? t("Completed")
          : failed
            ? t("Failed")
            : t("Cancelled");
  const statusStyle = {
    color: failed ? tokens.destructive : tokens.mutedForeground,
    ...nativeTextStyle("label", { weight: 500 }),
  };
  const time = routineTime(item.createdAt, withDay);
  const trailing = (
    <>
      {time && !nested ? (
        <Text
          style={{
            color: tokens.mutedForeground,
            ...nativeTextStyle("time"),
            fontVariant: ["tabular-nums"],
          }}
        >
          {time}
        </Text>
      ) : null}
      {block.state === "running" ? (
        <ShimmerText style={statusStyle}>{statusLabel}</ShimmerText>
      ) : (
        <Text style={statusStyle}>{statusLabel}</Text>
      )}
    </>
  );
  const symbol = ROUTINE_STATE_SYMBOL[block.state];
  const accessibilityLabel = [
    block.routineName,
    statusLabel,
    time,
    subscribed ? t("Notifications on") : null,
    handoff?.label,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <View>
      <Pressable
        {...(nested ? {} : actionProps)}
        accessible
        accessibilityRole={opens ? "button" : undefined}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={opens ? { expanded } : undefined}
        onPress={
          opens
            ? () => {
                fromTap.current = true;
                setManualExpanded(!expanded);
              }
            : undefined
        }
        // A thumb scrolling the thread past the line does not press it.
        unstable_pressDelay={130}
        style={({ pressed }) => ({
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginHorizontal: -8,
          paddingHorizontal: 8,
          borderRadius: radii.row,
          backgroundColor: pressed && opens ? tokens.secondary : "transparent",
        })}
      >
        <NativeSymbol
          ios={symbol.ios}
          android={symbol.android}
          size={nested ? 14 : 18}
          color={symbolColor}
        />
        <View style={{ flex: 1, gap: 2 }}>
          {/* The name is never truncated: it wraps before the trailing slots move.
              Inside a group every line is the same routine, so it says when instead. */}
          <Text
            style={{ color: tokens.foreground, ...nativeTextStyle("rowName", { weight: 500 }) }}
          >
            {nested && time ? time : block.routineName}
          </Text>
          {stacked ? <View style={{ flexDirection: "row", gap: 8 }}>{trailing}</View> : null}
        </View>
        {stacked ? null : trailing}
        {/* Fixed slots, kept when empty, so the columns line up down a run of routines. */}
        <View style={{ width: sizes.receipt, alignItems: "center" }}>
          {handoff && !expanded ? handoff.receipt : null}
        </View>
        <View style={{ width: 14, alignItems: "center" }}>
          {subscribed ? (
            <NativeSymbol
              ios="bell"
              android="notifications-outline"
              size={14}
              color={tokens.mutedForeground}
            />
          ) : null}
        </View>
        <View style={{ width: 14, alignItems: "center" }}>
          {opens ? <Disclosure open={expanded} /> : null}
        </View>
      </Pressable>
      <Expandable open={expanded} fromTap={fromTap}>
        <View
          style={{
            marginStart: nested ? 6 : 9,
            paddingStart: nested ? 20 : 18,
            borderStartWidth: 1,
            borderStartColor: tokens.outline,
            marginBottom: 8,
            gap: 10,
          }}
        >
          {digest ? (
            <ClippedPreview
              maxHeight={REPORT_PREVIEW_HEIGHT}
              fadeColor={tokens.background}
              onOpen={() => setReportOpen(true)}
              accessibilityLabel={t("Report, {name}", { name: block.routineName })}
            >
              <ChatMarkdown
                allowImages={false}
                palette={tokens}
                colorScheme={colorScheme}
                bleed={18}
              >
                {truncateMarkdownForRender(digest)}
              </ChatMarkdown>
            </ClippedPreview>
          ) : null}
          {handoff ? (
            <Interstitial
              accessibilityLabel={handoff.label}
              avatars={handoff.avatars}
              onPress={handoff.onPress}
            >
              {handoff.label}
            </Interstitial>
          ) : null}
        </View>
      </Expandable>
      {reportOpen && digest ? (
        <PreviewSheet title={block.routineName} onClose={() => setReportOpen(false)}>
          <View style={{ paddingTop: 16, gap: 16 }}>
            <ChatMarkdown allowImages={false} palette={tokens} colorScheme={colorScheme}>
              {truncateMarkdownForRender(digest)}
            </ChatMarkdown>
            {handoff ? (
              <Interstitial
                accessibilityLabel={handoff.label}
                avatars={handoff.avatars}
                onPress={handoffFromSheet(handoff, () => setReportOpen(false)).onPress}
              >
                {handoff.label}
              </Interstitial>
            ) : null}
          </View>
        </PreviewSheet>
      ) : null}
    </View>
  );
}

/** iOS's disclosure: a forward chevron that turns down when open. */
function Disclosure({ open }: { open: boolean }) {
  const tokens = mobileTokens();
  const reducedMotion = useChatReducedMotion();
  const turn = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    turn.value = reducedMotion
      ? open
        ? 1
        : 0
      : withTiming(open ? 1 : 0, { duration: 240, easing: CHAT_MOTION.botEnterEasing });
  }, [open, reducedMotion, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 90}deg` }] }));
  return (
    <Animated.View style={style}>
      <NativeSymbol
        ios="chevron.forward"
        android="chevron-forward-outline"
        size={14}
        color={tokens.mutedForeground}
      />
    </Animated.View>
  );
}

/**
 * Several consecutive routine runs of a bot, with no message between them,
 * as one line: how many, over what span, and whether any was cancelled
 * (failed and running runs are never folded, they keep their own line).
 * Opening it lists each run as a line of its own; a long group opens in a
 * sheet, by day.
 */
function RoutineGroup({
  runs,
  handoffFor,
  actionProps,
}: {
  runs: RoutineGroupRun[];
  handoffFor: (run: RoutineGroupRun) => RoutineHandoff | undefined;
  actionProps: MessageActionProps;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const fromTap = useRef(false);
  const first = runs[0]!;
  const last = runs.at(-1)!;
  const spansDays = !sameLocalDay(first.createdAt, last.createdAt);
  const range = routineRange(first.createdAt, last.createdAt);
  const cancelled = runs.filter((item) => item.run.state === "cancelled").length;
  const statusLabel = cancelled ? t("{count} cancelled", { count: cancelled }) : t("Completed");
  const countLabel = t("{count} runs", { count: runs.length });
  const handoffs = runs.map(handoffFor);
  const receipts = new Set(runs.map((item) => item.sentTo?.toBotId).filter(Boolean));
  const receipt = receipts.size === 1 ? handoffs.find(Boolean)?.receipt : null;
  const inSheet = runs.length > GROUP_INLINE_MAX;
  const lines = (
    <View style={{ marginStart: 28 }}>
      {runs.map((item, index) => (
        <RoutineRunLine
          key={item.messageId}
          item={item}
          handoff={handoffs[index]}
          actionProps={actionProps}
          nested
          withDay={spansDays}
        />
      ))}
    </View>
  );
  return (
    <View>
      <Pressable
        {...actionProps}
        accessibilityRole="button"
        accessibilityLabel={[first.run.routineName, countLabel, range, statusLabel].join(", ")}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          fromTap.current = true;
          setOpen(!open);
        }}
        unstable_pressDelay={130}
        style={({ pressed }) => ({
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          marginHorizontal: -8,
          paddingHorizontal: 8,
          borderRadius: radii.row,
          backgroundColor: pressed ? tokens.secondary : "transparent",
        })}
      >
        <NativeSymbol
          ios={ROUTINE_STATE_SYMBOL.completed.ios}
          android={ROUTINE_STATE_SYMBOL.completed.android}
          size={18}
          color={tokens.success}
        />
        {/* A group is one routine: its name, and how many earlier runs it holds. */}
        <Text
          style={{
            flex: 1,
            color: tokens.foreground,
            ...nativeTextStyle("rowName", { weight: 500 }),
          }}
        >
          {`${first.run.routineName} `}
          <Text style={{ color: tokens.mutedForeground }}>{countLabel}</Text>
        </Text>
        <Text
          style={{
            color: tokens.mutedForeground,
            ...nativeTextStyle("time"),
            fontVariant: ["tabular-nums"],
          }}
        >
          {range}
        </Text>
        <Text
          style={{ color: tokens.mutedForeground, ...nativeTextStyle("label", { weight: 500 }) }}
        >
          {statusLabel}
        </Text>
        <View style={{ width: sizes.receipt, alignItems: "center" }}>{receipt}</View>
        <View style={{ width: 14 }} />
        <View style={{ width: 14, alignItems: "center" }}>
          <Disclosure open={open && !inSheet} />
        </View>
      </Pressable>
      <Expandable open={open && !inSheet} fromTap={fromTap}>
        {lines}
      </Expandable>
      {open && inSheet ? (
        <PreviewSheet title={first.run.routineName} onClose={() => setOpen(false)}>
          <View style={{ paddingTop: 8 }}>
            {runs.map((item, index) => {
              const dayStarts =
                index === 0 || !sameLocalDay(runs[index - 1]!.createdAt, item.createdAt);
              return (
                <View key={item.messageId}>
                  {dayStarts && item.createdAt ? (
                    <Text
                      style={{
                        marginTop: index === 0 ? 8 : 16,
                        marginBottom: 4,
                        color: tokens.mutedForeground,
                        ...nativeTextStyle("label", { weight: 500 }),
                      }}
                    >
                      {threadTimeMarkerLabel(item.createdAt, {
                        locale: dateLocaleForUi(),
                        today: t("Today"),
                        yesterday: t("Yesterday"),
                        withTime: false,
                      })}
                    </Text>
                  ) : null}
                  <RoutineRunLine
                    item={item}
                    handoff={
                      handoffs[index]
                        ? handoffFromSheet(handoffs[index]!, () => setOpen(false))
                        : undefined
                    }
                    actionProps={actionProps}
                    nested
                  />
                </View>
              );
            })}
          </View>
        </PreviewSheet>
      ) : null}
    </View>
  );
}

/**
 * A delegated task's result (a subagent): the thread's only
 * outlined card, with a document glyph, so a work product reads apart from a
 * bubble, the raised question and a routine's log line. The whole card is one
 * target: it opens the full brief and result in a sheet (a long result fades
 * out under the expand badge). A finished task shows no status word; running,
 * failed and cancelled do, under the title.
 */
function TaskCard({
  title,
  state,
  meta,
  body,
  streaming = false,
  actionProps,
}: {
  title: string;
  state: TaskCardState;
  meta?: string;
  /** Markdown result, shown as a preview and whole in the sheet. */
  body?: string;
  streaming?: boolean;
  actionProps?: MessageActionProps;
}) {
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const [sheetOpen, setSheetOpen] = useState(false);
  const statusColor = state === "failed" ? tokens.destructive : tokens.mutedForeground;
  const statusStyle = { color: statusColor, ...nativeTextStyle("label", { weight: 500 }) };
  const statusLabel =
    state === "running" ? t("Running") : state === "failed" ? t("Failed") : t("Cancelled");
  const statusSymbol =
    state === "running"
      ? ROUTINE_STATE_SYMBOL.running
      : state === "failed"
        ? ROUTINE_STATE_SYMBOL.failed
        : ROUTINE_STATE_SYMBOL.cancelled;
  const open = body || meta ? () => setSheetOpen(true) : undefined;
  const header = (full: boolean) => (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <NativeSymbol
          ios="doc.text"
          android="document-text-outline"
          size={18}
          color={tokens.foreground}
        />
        <Text
          accessibilityRole="header"
          style={{
            flex: 1,
            color: tokens.foreground,
            ...nativeTextStyle("rowName", { weight: 600 }),
          }}
        >
          {title}
        </Text>
      </View>
      {state === "done" ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginStart: 28 }}>
          <NativeSymbol
            ios={statusSymbol.ios}
            android={statusSymbol.android}
            size={13}
            color={statusColor}
          />
          {state === "running" ? (
            <ShimmerText style={statusStyle}>{statusLabel}</ShimmerText>
          ) : (
            <Text style={statusStyle}>{statusLabel}</Text>
          )}
        </View>
      )}
      {meta ? (
        <Text
          numberOfLines={full ? undefined : 2}
          style={{ color: tokens.mutedForeground, marginStart: 28, ...nativeTextStyle("meta") }}
        >
          {meta}
        </Text>
      ) : null}
    </View>
  );
  const markdown = body ? (
    <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={streaming} bleed={14}>
      {body}
    </ChatMarkdown>
  ) : null;
  return (
    <>
      <Pressable
        {...actionProps}
        accessibilityRole={open ? "button" : undefined}
        accessibilityLabel={[title, meta].filter(Boolean).join(", ")}
        accessibilityHint={open ? t("Opens in full") : undefined}
        disabled={!open}
        onPress={open}
        unstable_pressDelay={130}
      >
        {({ pressed }) => (
          <Surface
            variant="outlined"
            style={{ overflow: "hidden", backgroundColor: pressed ? tokens.secondary : undefined }}
          >
            <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>{header(false)}</View>
            {markdown ? (
              <View
                // The card is the target: the preview (a table included) does not take touches.
                pointerEvents="none"
                style={{
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: tokens.border,
                  paddingHorizontal: 14,
                  paddingTop: 12,
                  paddingBottom: 12,
                }}
              >
                <ClippedPreview
                  maxHeight={TASK_PREVIEW_HEIGHT}
                  fadeColor={pressed ? tokens.secondary : tokens.surface}
                  onOpen={() => open?.()}
                  accessibilityLabel={title}
                >
                  {markdown}
                </ClippedPreview>
              </View>
            ) : null}
          </Surface>
        )}
      </Pressable>
      {sheetOpen ? (
        <PreviewSheet title={title} onClose={() => setSheetOpen(false)}>
          <View style={{ paddingTop: 16, gap: 16 }}>
            {meta ? (
              <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
                {meta}
              </Text>
            ) : null}
            {body ? (
              <ChatMarkdown palette={tokens} colorScheme={colorScheme} streaming={streaming}>
                {body}
              </ChatMarkdown>
            ) : null}
          </View>
        </PreviewSheet>
      ) : null}
    </>
  );
}

/** The quote of the message a reply answers, above its bubble (or its card), unfilled. */
function ReplyQuote({
  message,
  replyPreview,
}: {
  message: MobileMessage;
  replyPreview?: MobileMessage;
}) {
  const tokens = mobileTokens();
  if (!replyPreview && !(message.replyToMessageId && message.replyQuote)) return null;
  return (
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
  );
}

/**
 * What was said: the person's words in the `chatUser` bubble, a bot's in its
 * `muted` narration bubble (design contract § Grouping — "1 message = 1
 * bubble") — never both in the same box. The reply preview stays above the
 * bubble, aligned on its edge, unfilled.
 */
function MessageText({
  message,
  replyPreview,
  actionProps,
  mono = false,
}: {
  message: MobileMessage;
  replyPreview?: MobileMessage;
  actionProps: MessageActionProps;
  mono?: boolean;
}) {
  const colorScheme = useResolvedAppearance();
  const tokens = mobileTokens();
  const contentText = blockText(message);
  if (!contentText) return null;
  const parent = <ReplyQuote message={message} replyPreview={replyPreview} />;
  // `onLongPress` is deliberately left out here: the row-level RNGH gesture
  // (`AnimatedMessageBubble`) owns the long press for a plain text bubble,
  // and mixing the RN responder with RNGH on the same view is exactly what
  // the design-motion spec's transverse rules forbid. Accessibility actions
  // still live on the bubble itself.
  if (message.role === "user") {
    return (
      <View style={{ alignItems: "flex-end" }}>
        {parent}
        <UserBubble
          accessibilityActions={actionProps.accessibilityActions}
          onAccessibilityAction={actionProps.onAccessibilityAction}
        >
          {/* The long press is the row gesture's (AnimatedMessageBubble), not the text's. */}
          <LinkifiedText>{contentText}</LinkifiedText>
        </UserBubble>
      </View>
    );
  }
  return (
    <View style={{ alignItems: "flex-start", minWidth: 0, maxWidth: "100%" }}>
      {parent}
      <BotBubble
        accessibilityActions={actionProps.accessibilityActions}
        onAccessibilityAction={actionProps.onAccessibilityAction}
        mono={mono}
      >
        <ChatMarkdown
          palette={tokens}
          colorScheme={colorScheme}
          streaming={message.id.startsWith("progress:")}
          inBubble
        >
          {contentText}
        </ChatMarkdown>
      </BotBubble>
    </View>
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

  // Once settled the progress dots have nothing left to track, and a single
  // question is already the card's own question line: only the answer stays.
  // Mirrors `apps/web/src/components/AskCard.tsx`.
  const answerValue = (question: (typeof questions)[number]) => {
    const stored = ask.answers?.[question.id];
    const labels = (stored?.selected ?? []).map(
      (id) => question.options?.find((option) => option.id === id)?.label ?? id,
    );
    if (stored?.other) labels.push(`${t("Other")}: ${stored.other}`);
    return stored?.skipped && labels.length === 0 ? t("Skipped") : labels.join(", ");
  };
  const hasStoredAnswers = Boolean(ask.answers && Object.keys(ask.answers).length > 0);
  const answeredContent = answered ? (
    total === 1 ? (
      hasStoredAnswers ? (
        <Text style={{ color: tokens.foreground, ...nativeTextStyle("body") }}>
          {answerValue(current) || t("Answered")}
        </Text>
      ) : (
        <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
          {t("Answered")}
        </Text>
      )
    ) : (
      <View style={{ gap: 10 }}>
        {questions.map((question, qIndex) => (
          <View key={question.id}>
            <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
              {qIndex + 1}. {question.question}
            </Text>
            {hasStoredAnswers ? (
              <Text style={{ color: tokens.foreground, ...nativeTextStyle("body") }}>
                {answerValue(question) || t("Answered")}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    )
  ) : !canAnswer ? (
    <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
      {t("No longer active")}
    </Text>
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
      question={<Text {...actionProps}>{current.question}</Text>}
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
