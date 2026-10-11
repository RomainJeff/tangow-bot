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
  EntryId,
  MessageBlock,
  Routine,
  SessionEntry,
  ThreadItem,
  ThreadMessagePage,
} from "@rakazo/contracts";
import {
  canReactToThreadMessage,
  MESSAGE_REACTIONS,
  type MessageReaction,
} from "@rakazo/contracts";
import {
  abortableDelay,
  appendedEntries,
  attachmentsForThread,
  buildComposerMentionOptions,
  type ComposerMention,
  canEditSpawnBotCard,
  isApprovalAskBlock,
  isAsideOnlyMessage,
  isRunTerminalEvent,
  isSecretAskBlock,
  latestActivityLabel,
  mentionChipKey,
  projectThreadView,
  type RoutineLineRole,
  type RoutineLineRun,
  resolveComposerSendPlan,
  routineCardSettlement,
  SLASH_ACTIONS,
  type SlashActionId,
  selectedAskActionLabel,
  serializeComposerPrompt,
  skillSourcesOf,
  slashSkillOptions as slashSkills,
  type ThreadRow,
  type ThreadView,
  threadTimeMarkerLabel,
  truncateSlashDescription,
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
import type { BotBubbleMeta } from "../components/bot-bubble";
import { BotBubble, BubbleMeta } from "../components/bot-bubble";
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
  keepUnchangedRows,
  loadSessionToken,
  type MobileBot,
  type MobileGroup,
  type MobileMe,
  type MobileMessage,
  type MobileSnapshot,
  type MobileSpaceNavigation,
  type MobileThreadResponse,
  mergeMobileSnapshot,
  messagingProviderLabel,
  mobileSnapshotOf,
  rpc,
  selectedSpaceId,
  selectSpace,
  shouldApplyMobileThreadRefresh,
  subscribeThread,
  withOlderPage,
} from "../lib/api";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { type MobileArtifactTarget, openMobileArtifact } from "../lib/artifact-open";
import { presentAttachSheet } from "../lib/attach-sheet";
import { stateWord } from "../lib/bot-activity";
import {
  archiveBot,
  clearConversation,
  confirmClearConversation,
  confirmDeleteBot,
} from "../lib/bot-lifecycle";
import { botMessageCard } from "../lib/bot-message-card";
import { noteBotRunEnded } from "../lib/bot-page-state";
import { CHAT_MOTION, useChatReducedMotion } from "../lib/chat-motion";
import { cancelFocusPrompt, focusPromptThreadActive } from "../lib/focus-prompt";
import { formatShortDuration } from "../lib/format-elapsed";
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
  skillLineRoute,
  skillLineSegment,
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
type ReplyTarget = { message: MobileMessage; messageId: EntryId };
type RunItem = Extract<ThreadItem, { kind: "run" }>;
type NoteItem = Extract<ThreadItem, { kind: "note" }>;
/** The card an answer goes to: the run that asked, and the entry holding the question. */
type CardTarget = { runId: string; entryId: string };
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
 * narration — a decision, an ask, a channel note, a bot card or a bare
 * attachment. Swipe-to-reply is a *narration* bubble's
 * gesture only; these keep today's plain long-press wrapper. */
const CARD_ONLY_BLOCK_KINDS = new Set<string>([
  "ask",
  "channel_message",
  "meta",
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

/** An item the thread draws nothing for, left out before groups, reactions and markers. */
function drawsNothing(item: ThreadItem, showSteps: boolean): boolean {
  switch (item.kind) {
    case "message":
      return !hasVisibleMessagePresentation(item.blocks, showSteps);
    case "effect":
      return !item.card;
    case "note":
      return item.type !== "system.note" && item.type !== "skill.learnt";
    default:
      return false;
  }
}

/** The open run's streamed text, which the run's next entry replaces. */
function isLiveMessage(item: ThreadItem): item is Extract<MobileMessage, { role: "bot" }> {
  return item.kind === "message" && item.role === "bot" && item.live === true;
}

/** A note between rows rather than something said: consecutive ones stack with no gap. */
function isAsideItem(item: ThreadItem, showSteps: boolean): boolean {
  switch (item.kind) {
    case "message":
      return isAsideOnlyMessage(visibleMessageBlocks(item.blocks, showSteps));
    case "handoff":
    case "botMessage":
    case "note":
      return true;
    default:
      return false;
  }
}

function isBotWords(entry: SessionEntry): boolean {
  return entry.type === "assistant.text" || entry.type === "bot.text";
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
  const scroll = useRef<FlatList<ThreadRow>>(null);
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
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
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
  const liveRowsRef = useRef<readonly ThreadRow[]>([]);
  const holdRow = useCallback((rowId: string | null) => {
    holdingRowUntil.current = Date.now() + 900;
    const rows = liveRowsRef.current;
    const index = rowId ? rows.findIndex((row) => row.item.id === rowId) : -1;
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
  // The thread as the person sees it, projected from the held entries the way web projects them:
  // groups, reactions, routine folds and time markers come with the rows, in chronological order,
  // and both the live inverted list and the pinned page read them.
  const drawnRows = useRef<ReadonlyMap<string, ThreadRow>>(new Map());
  const view = useMemo((): ThreadView => {
    const projected = projectThreadView(snap?.entries ?? [], {
      rendersNothing: (item) => drawsNothing(item, showSteps),
      progress: snap?.progress,
    });
    const rows = keepUnchangedRows(drawnRows.current, projected.rows);
    drawnRows.current = new Map(rows.map((row) => [row.item.id, row]));
    return { ...projected, rows };
  }, [snap?.entries, snap?.progress, showSteps]);
  const rows = view.rows;
  const waiting = view.waiting;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  const latestMessageId = rows.at(-1)?.item.id ?? null;
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.item.id, index])), [rows]);
  const rewindIndex = rewindTarget ? (rowIndex.get(rewindTarget.id) ?? -1) : -1;
  const rewindRemovedCount = rewindIndex >= 0 ? rows.length - rewindIndex - 1 : 0;
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
    slashQuery !== null && mentionQuery === null ? slashSkills(agentSkills, slashQuery) : [];
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
  const liveItems = useMemo(
    () => rows.flatMap((row) => (isLiveMessage(row.item) ? [row.item] : [])),
    [rows],
  );
  const hasLiveProgress = liveItems.length > 0;
  // One bot only: an activity line names one bot's tool, so it would mislabel a group.
  const activityLabel = latestActivityLabel(liveItems);
  // The runs a working line speaks for: a run the thread waits on for an answer is not working.
  const workingRuns = useMemo(() => {
    const runs = snap?.activeRuns ?? (snap?.run ? [snap.run] : []);
    return runs.filter((run) => isWorkingStatus(run.status) && run.id !== waiting?.runId);
  }, [snap?.activeRuns, snap?.run, waiting?.runId]);
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
  const botWorking = isWorkingStatus(currentBotStatus) && snap?.run?.id !== waiting?.runId;
  const working = inGroup ? workingGroupBots.length > 0 : botWorking;

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
      // Bot actions (bot settings, open computer, clear, archive, delete) live
      // on a long press; a short press opens the bot's page.
      headerTitle: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={displayName || t("Thread")}
          disabled={inGroup || !botId}
          onPress={() => {
            if (!botId || inGroup) return;
            router.push({ pathname: "/bot", params: { botId } });
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

  function clearThread() {
    if (!botId) return;
    setError(null);
    clearConversation(botId, () => {
      expandedHistoryThread.current = null;
      pinnedAroundRef.current = null;
      historyEpoch.current += 1;
    });
  }

  const botActions = [
    {
      text: t("Bot settings"),
      onPress: () =>
        router.push({
          pathname: "/bot",
          params: { botId: botId ?? "", tab: "settings" },
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
      onPress: () => confirmClearConversation(clearThread),
    },
    {
      text: t("Archive"),
      onPress: () => {
        if (botId) archiveBot(botId, leaveBot);
      },
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
    const next = mobileSnapshotOf(
      await rpc<MobileThreadResponse>(
        "threads/get",
        targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! },
      ),
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
    const [response, page] = await Promise.all([
      rpc<MobileThreadResponse>("threads/get", threadTarget),
      rpc<ThreadMessagePage>("threads/messages", {
        ...threadTarget,
        around: { entryId: target.messageId },
      }),
    ]);
    const snap = mobileSnapshotOf(response);
    // The epoch check drops a jump that raced a conversation clear (or a bot switch); the
    // generation check drops an older same-thread jump that finished after a newer one.
    if (epoch !== historyEpoch.current || jumpId !== jumpGeneration.current) return;
    if (target.groupId && activeGroupId.current !== target.groupId) return;
    if (target.botId && activeBotId.current !== target.botId) return;
    const targetInPage = page.entries.some((entry) => entry.id === target.messageId);
    expandedHistoryThread.current = targetInPage ? page.threadId : null;
    pinnedAroundRef.current = targetInPage
      ? { ...threadTarget, messageId: target.messageId }
      : null;
    jumpScrollTarget.current = targetInPage ? target.messageId : null;
    setSnap(
      targetInPage ? { ...snap, entries: page.entries, olderCursor: page.olderCursor } : snap,
    );
  }

  async function loadOlderMessages() {
    if ((!botId && !groupId) || snap?.olderCursor == null || loadingOlder) return;
    loadingOlderContent.current = true;
    setLoadingOlder(true);
    const epoch = historyEpoch.current;
    try {
      const page = await rpc<ThreadMessagePage>("threads/messages", {
        ...(groupId ? { groupId } : { botId: botId! }),
        before: snap.olderCursor,
      });
      if (epoch !== historyEpoch.current) {
        loadingOlderContent.current = false;
        return;
      }
      expandedHistoryThread.current = page.threadId;
      setSnap((prev) => withOlderPage(prev, page));
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
        ? await rpc<MobileThreadResponse>(
            "threads/get",
            groupId ? { groupId } : { botId: botId! },
          ).catch((err: Error) => {
            setError(err.message);
            return null;
          })
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
              cursor = Math.max(cursor, event.seq);
              retryMs = 250;
              const appended = appendedEntries(event);
              if (appended.some((entry) => entry.type === "clear")) {
                expandedHistoryThread.current = null;
                pinnedAroundRef.current = null;
                historyEpoch.current += 1;
              }
              setSnap((prev) => applyMobileThreadEvent(prev, event));
              if (event.type === "bot.updated") {
                void refreshMentionBots();
              }
              if (appended.some(isBotWords)) {
                readVisibleTarget.current = null;
                markReadIfVisible();
              }
              if (isRunTerminalEvent(event)) {
                if (botId) noteBotRunEnded(botId);
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
      rows
        .flatMap((row) =>
          row.item.kind === "message" && row.item.role === "user" ? [row.item] : [],
        )
        .slice(-8)
        .map((message) => blockText(message)),
    [rows],
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
        router.push({ pathname: "/bot", params: { botId, tab: "settings" } });
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
              replyToMessageId: reroutedToGroup
                ? undefined
                : composerSnapshot.replyTarget?.messageId,
              linkPreview: withoutLinkPreview ? (false as const) : undefined,
            }
          : {
              botId: botTarget!,
              clientNonce,
              text: trimmed || undefined,
              mentions: plan.mentionPayload.length ? plan.mentionPayload : undefined,
              artifactIds: artifactIds.length ? artifactIds : undefined,
              replyToMessageId: composerSnapshot.replyTarget?.messageId,
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

  /** Answers a card: the run that asked, and the entry that holds the question. */
  const answerCard = useCallback(
    async (card: CardTarget, answer: string, edits?: SpawnBotEdits) => {
      const targetBotId = botId;
      const targetGroupId = groupId;
      if (!targetBotId && !targetGroupId) return;
      try {
        await rpc("threads/answer", {
          ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
          runId: card.runId,
          messageId: card.entryId,
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
  // A ref, so a new projection does not hand every bubble a new handler.
  const answerMessage = useCallback(
    async (message: MobileMessage, answer: string, edits?: SpawnBotEdits) => {
      const card = waitingRef.current;
      if (card?.itemId !== message.id) return;
      await answerCard({ runId: card.runId, entryId: card.entryId }, answer, edits);
    },
    [answerCard],
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
      void speakMessage(
        (message.role === "bot" ? message.botId : botId) ?? snap?.members?.[0]?.botId ?? "",
        message,
      ).catch((err) =>
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

  const answerableAskMessageId = waiting?.itemId ?? null;
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
  const liveRows = useMemo(() => [...rows].reverse(), [rows]);
  liveRowsRef.current = liveRows;
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
  const arrivals = useMemo(
    () =>
      rows.map(({ item }) => ({
        id: item.id,
        createdAt: item.ts,
        ...(item.kind === "message" && item.role === "bot" && item.runId
          ? { runId: item.runId }
          : {}),
      })),
    [rows],
  );
  const newMessageIds = useMessageArrivals(snap?.threadId, arrivals, {
    seed: loadingOlderContent.current || showPinnedPage,
  });
  const arrivalStaggerMs = useMemo(
    () => messageArrivalStaggerMs(arrivals.filter((arrival) => newMessageIds.has(arrival.id))),
    [arrivals, newMessageIds],
  );
  const reactions = useMemo(
    () =>
      new Map(
        rows.flatMap((row) =>
          row.reactions.length > 0 ? [[row.item.id, new Map(row.reactions)] as const] : [],
        ),
      ),
    [rows],
  );
  // 7d: a reaction pill pops on appearing or its count rising, never on mount alone.
  const poppedReactionKeys = useReactionPops(threadKey, reactions);
  const labelOptions = { locale: dateLocaleForUi(), today: t("Today"), yesterday: t("Yesterday") };
  const jumpRowId = jumpScrollTarget.current ? view.rowOf.get(jumpScrollTarget.current) : undefined;

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

  async function reactToMessage(messageId: EntryId, reaction: MessageReaction) {
    const targetBotId = botId;
    const targetGroupId = groupId;
    if (!targetBotId && !targetGroupId) return;
    try {
      await rpc("threads/react", {
        ...(targetGroupId ? { groupId: targetGroupId } : { botId: targetBotId! }),
        messageId,
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

  function messageActionGroups(
    message: MobileMessage,
    messageId: EntryId | undefined,
  ): MessageSheetAction[][] {
    const text = copyableMobileMessageText(message);
    return [
      [
        ...(messageId
          ? [
              {
                name: "reply",
                text: t("Reply"),
                icon: { ios: "arrowshape.turn.up.left", android: "arrow-undo-outline" } as const,
                onPress: () => setReplyTarget({ message, messageId }),
              },
            ]
          : []),
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
  function messageActions(message: MobileMessage, messageId: EntryId | undefined) {
    const [primary = [], rest = []] = messageActionGroups(message, messageId);
    return [
      primary[0],
      ...(messageId && canReactToThreadMessage(message)
        ? [
            {
              name: "react",
              text: t("React"),
              onPress: () => showMessageActions(message, messageId),
            },
          ]
        : []),
      ...primary.slice(1),
      ...rest,
      ...(copyableMobileMessageText(message)
        ? [
            {
              name: "select",
              text: t("Select text"),
              onPress: () => showMessageActions(message, messageId, "text"),
            },
          ]
        : []),
    ].filter((action) => action !== undefined);
  }

  function showMessageActions(
    message: MobileMessage,
    messageId: EntryId | undefined,
    mode: "actions" | "text" = "actions",
  ) {
    if (mode === "actions") selectionHaptic();
    const owner = `thread:${threadKey}`;
    messageSheetOwner.current = owner;
    openSheet(
      router,
      (close) => (
        <MessageActionsSheet
          initialMode={mode}
          reactions={
            messageId && canReactToThreadMessage(message)
              ? MESSAGE_REACTIONS.map((emoji) => ({
                  emoji,
                  onPress: () => void reactToMessage(messageId, emoji),
                }))
              : []
          }
          groups={messageActionGroups(message, messageId)}
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
    () =>
      new WeakMap<MobileMessage, { messageId: EntryId | undefined; props: MessageActionProps }>(),
    [locale],
  );
  function messageActionProps(
    message: MobileMessage,
    messageId: EntryId | undefined,
  ): MessageActionProps {
    const cached = actionPropsCache.get(message);
    if (cached && cached.messageId === messageId) return cached.props;
    const props: MessageActionProps = {
      onLongPress: () => latestActions.current.showMessageActions(message, messageId),
      accessibilityActions: messageActions(message, messageId).map((action) => ({
        name: action.name,
        label: action.text,
      })),
      onAccessibilityAction: (event) => {
        latestActions.current
          .messageActions(message, messageId)
          .find((action) => action.name === event.nativeEvent.actionName)
          ?.onPress();
      },
    };
    actionPropsCache.set(message, { messageId, props });
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
   * asides and between two routine lines, 3 within a group, 14 otherwise
   * (opening a new group, or the very first rendered row). */
  function gapBeforeRow(row: ThreadRow, previous: ThreadRow | undefined): number {
    if (previous && isAsideItem(row.item, showSteps) && isAsideItem(previous.item, showSteps)) {
      return 0;
    }
    if (row.item.kind === "routine" && previous?.item.kind === "routine") return 0;
    return row.firstOfGroup ? GROUP_GAP : WITHIN_GROUP_GAP;
  }

  /** The message a reply names, when the thread holds it. */
  function repliedMessage(entryId: EntryId): MobileMessage | undefined {
    const rowId = view.rowOf.get(entryId);
    const item = rowId === undefined ? undefined : rows[rowIndex.get(rowId) ?? -1]?.item;
    return item?.kind === "message" ? item : undefined;
  }

  function renderRow(row: ThreadRow, options?: { enableJump?: boolean; previous?: ThreadRow }) {
    const { item } = row;
    const marker = row.marker
      ? threadTimeMarkerLabel(row.marker.at, { ...labelOptions, withTime: row.marker.withTime })
      : "";
    // MA-1: never for a row present at thread open, "Load earlier", or the
    // jump/pinned page: `options.enableJump` is only ever passed by the
    // pinned ScrollView's own call site.
    const isNew = Boolean(!options?.enableJump && newMessageIds.has(item.id));
    const rewound = rewindIndex >= 0 && (rowIndex.get(item.id) ?? -1) >= rewindIndex;
    return (
      <ThreadRowContext.Provider key={item.id} value={item.id}>
        <View
          onLayout={
            options?.enableJump
              ? (event) => {
                  if (jumpRowId !== item.id) return;
                  const y = Math.max(0, event.nativeEvent.layout.y - 24);
                  requestAnimationFrame(() => {
                    if (!jumpScrollTarget.current) return;
                    pinnedScroll.current?.scrollTo({ y, animated: true });
                    jumpScrollTarget.current = null;
                  });
                }
              : undefined
          }
          style={{
            // A day marker between two routine lines still needs its air above.
            marginTop: Math.max(marker ? GROUP_GAP : 0, gapBeforeRow(row, options?.previous)),
          }}
        >
          {marker ? (
            <Text
              style={{
                alignSelf: "center",
                marginBottom: GROUP_GAP,
                color: tokens.mutedForeground,
                ...nativeTextStyle("label"),
              }}
            >
              {marker}
            </Text>
          ) : null}
          <View style={{ opacity: rewound ? 0.4 : 1 }}>
            {item.kind === "message" ? (
              renderMessage(row, item, isNew, options?.enableJump)
            ) : (
              <ItemRow
                row={row}
                botId={botId ?? snap?.members?.[0]?.botId ?? ""}
                groupId={groupId}
                botName={displayName}
                bots={mentionBots}
                members={snap?.members}
                isNew={isNew}
                canAnswer={item.id === answerableAskMessageId}
                viewerUserId={viewerUserId}
                onAnswer={answerCard}
              />
            )}
          </View>
        </View>
      </ThreadRowContext.Provider>
    );
  }

  function renderMessage(
    row: ThreadRow,
    message: MobileMessage,
    isNew: boolean,
    enableJump: boolean | undefined,
  ) {
    const actionProps = messageActionProps(message, row.messageId);
    const messageReactions = row.reactions;
    const drawnBlocks = visibleMessageBlocks(message.blocks, showSteps);
    // An aside is a note between messages and carries no author; a bot's
    // question or approval is a normal row, its FramedBlock card just the
    // row's body. Aside is decided by the blocks alone.
    const chrome: MessageChrome = isAsideOnlyMessage(drawnBlocks) ? "aside" : "row";
    const authorBotId = message.role === "bot" ? message.botId : botId;
    const author = messageBot(authorBotId);
    const authorStatus = isLiveMessage(message)
      ? (snap?.activeRuns?.find((run) => run.botId === authorBotId)?.status ??
        (snap?.run?.botId === authorBotId ? snap?.run?.status : currentBotStatus))
      : undefined;
    // 7g: swipe-to-reply is a bot *narration* bubble's gesture only — a
    // decision card, an ask or an attachment keep their existing behaviour untouched.
    const isNarrationBotBubble =
      chrome === "row" &&
      message.role === "bot" &&
      drawnBlocks.length > 0 &&
      !drawnBlocks.some((block) => CARD_ONLY_BLOCK_KINDS.has(block.kind));
    const replyTo = message.role === "user" ? message.replyTo : undefined;
    const replyPreviewNode =
      chrome === "row" && replyTo ? repliedMessage(replyTo.entryId) : undefined;
    // The preview card sits under the bubble, or takes its place when the message is only the
    // link. A message that is itself a card (ask, ...) never carries one.
    const previewCard = chrome === "row" ? linkPreviewCardOf(message) : undefined;
    const cardReplacesBubbleView = previewCard
      ? cardReplacesBubble(drawnBlocks, previewCard)
      : false;
    const replyToRow = () => {
      if (row.messageId) setReplyTarget({ message, messageId: row.messageId });
    };
    const bubble = (
      <MessageBubble
        botId={botId ?? snap?.members?.[0]?.botId ?? ""}
        groupId={groupId}
        message={message}
        replyPreview={replyPreviewNode}
        canAnswer={message.id === answerableAskMessageId}
        viewerUserId={viewerUserId}
        onAnswer={answerMessage}
        onOpenBot={openBot}
        onPreviewMarkdown={setMarkdownPreview}
        actionProps={actionProps}
        isNew={isNew}
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
          // The card takes the bubble's place: the quote it carried stays above it, its skill lines under it.
          <View style={{ alignItems: message.role === "user" ? "flex-end" : "flex-start" }}>
            <ReplyQuote message={message} replyPreview={replyPreviewNode} />
            {previewNode}
            <CardSkillLines message={message} isNew={isNew} />
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
      <>
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
            showAuthor={inGroup && row.firstOfGroup}
            showAvatar={inGroup && row.lastOfGroup}
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
                    !enableJump &&
                    Boolean(row.messageId) &&
                    !message.blocks.some(
                      (block) => block.kind === "text" && hasMarkdownTable(block.text),
                    )
                  }
                  onLongPress={actionProps.onLongPress}
                  onSwipeReply={replyToRow}
                  accessibilityActions={actionProps.accessibilityActions}
                  onAccessibilityAction={actionProps.onAccessibilityAction}
                >
                  {bubble}
                </AnimatedMessageBubble>
              ) : (
                <MessageArrival isNew={isNew} enterDelayMs={arrivalStaggerMs.get(message.id) ?? 0}>
                  <Pressable accessible={false} onLongPress={actionProps.onLongPress}>
                    {bubble}
                  </Pressable>
                </MessageArrival>
              ),
            )}
          </MessageRow>
        ) : chrome === "row" ? (
          withPreview(
            <AnimatedMessageBubble
              variant="user"
              isNew={isNew}
              onLongPress={actionProps.onLongPress}
              accessibilityActions={actionProps.accessibilityActions}
              onAccessibilityAction={actionProps.onAccessibilityAction}
            >
              {bubble}
            </AnimatedMessageBubble>,
          )
        ) : (
          <View>{bubble}</View>
        )}
        {messageReactions.length > 0 ? (
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
            {messageReactions.map(([emoji, count]) => (
              <ReactionPill
                key={emoji}
                emoji={emoji}
                count={count}
                pop={poppedReactionKeys.has(reactionPopKey(message.id, emoji))}
              />
            ))}
          </View>
        ) : null}
      </>
    );
  }

  const workingBotsForLine = inGroup
    ? workingGroupBots
    : currentBot && botWorking && !hasLiveProgress
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
                {rows.map((row, index) =>
                  renderRow(row, { enableJump: true, previous: rows[index - 1] }),
                )}
                {workingFooter}
              </ScrollView>
            ) : (
              <FlatList
                key={threadKey}
                ref={scroll}
                data={liveRows}
                inverted
                keyExtractor={(row) => row.item.id}
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
                renderItem={({ item, index }) => renderRow(item, { previous: liveRows[index + 1] })}
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
                    {previewMessageText(replyTarget.message)}
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
  groupId,
  message,
  replyPreview,
  canAnswer,
  viewerUserId,
  onAnswer,
  onOpenBot,
  onPreviewMarkdown,
  actionProps,
  isNew,
  previewedUrl,
}: {
  botId: string;
  groupId?: string;
  message: MobileMessage;
  replyPreview?: MobileMessage;
  canAnswer: boolean;
  viewerUserId?: string;
  onAnswer: (message: MobileMessage, answer: string, edits?: SpawnBotEdits) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
  actionProps: MessageActionProps;
  /** Arrived while the thread was open: its skill lines play their entrance. */
  isNew: boolean;
  /** The link its card shows: a line that is only this link is left out of the text drawn. */
  previewedUrl?: string;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const showSteps = useDisplayAgentSteps();
  const artifactTarget: MobileArtifactTarget = groupId ? { groupId } : { botId };
  const cardBotId = message.role === "bot" ? message.botId : botId;
  // Mono-bot grammar (design contract §3b): the narration bubble caps at 82%
  // of the thread instead of 88% of the content column.
  const mono = !groupId;
  const metaLines = useSkillLines(message, isNew);
  // A card draws no bubble to hang the lines under, so they stand alone below it.
  const withSkillLines = (card: ReactNode) =>
    metaLines.length > 0 ? (
      <View style={{ gap: 8, width: "100%" }}>
        {card}
        <BubbleMeta lines={metaLines} standalone />
      </View>
    ) : (
      card
    );
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
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
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
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
      </View>
    );
  }
  // An aside is a note between messages, not something a bot said: like the
  // web transcript it carries no author, no bubble and no message actions.
  const channelMessage = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "channel_message" }> =>
      block.kind === "channel_message",
  );
  if (channelMessage) {
    return withSkillLines(
      <Interstitial avatars={null}>
        {`${messagingProviderLabel(channelMessage.provider, channelMessage.transport)} · ${
          channelMessage.fromLabel
        }: ${channelMessage.text}`}
      </Interstitial>,
    );
  }
  const metaNote = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "meta" }> => block.kind === "meta",
  );
  if (metaNote) {
    return withSkillLines(<Interstitial avatars={null}>{metaNote.text}</Interstitial>);
  }
  const special = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "child_bot" }> => block.kind === "child_bot",
  );
  if (special) {
    const removed = special.status === "deleted" || special.status === "archived";
    return withSkillLines(
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
      </Pressable>,
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
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
      </View>
    );
  }
  const askBlock = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && Boolean(block.actions?.length),
  );
  if (askBlock) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <ApprovalCard
          block={askBlock}
          cardId={message.id}
          cardBotId={cardBotId}
          canAnswer={canAnswer}
          viewerUserId={viewerUserId}
          actionProps={actionProps}
          onAnswer={(answer, edits) => onAnswer(message, answer, edits)}
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
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
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
        {replyQuote(message, replyPreview) ? (
          <Text
            style={{
              color: message.role === "user" ? tokens.chatUserForeground : tokens.mutedForeground,
              ...nativeTextStyle("meta"),
            }}
            numberOfLines={2}
          >
            {replyQuote(message, replyPreview)}
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
        {metaLines.length > 0 ? <BubbleMeta lines={metaLines} /> : null}
      </Surface>
    );
  }
  const segments = messagePresentationSegments(shownBlocks);
  const steps = showSteps ? stepsBlocks(message.blocks) : [];
  const live = isLiveMessage(message);
  const firstContent = segments.findIndex((segment) => segment.kind === "content");
  const lastContent = skillLineSegment(
    segments.map((segment) => blockText({ ...message, blocks: segment.blocks })),
  );
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
          meta={index === lastContent ? metaLines : undefined}
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
      {lastContent < 0 && metaLines.length > 0 ? <BubbleMeta lines={metaLines} standalone /> : null}
    </View>
  );
});

/**
 * A card waiting on the person's call, or showing the call they made: an approval, a question with
 * fixed options, a routine card. A message's ask with actions and an approval's effect row both
 * draw it.
 */
function ApprovalCard({
  block,
  cardId,
  cardBotId,
  canAnswer,
  viewerUserId,
  actionProps,
  onAnswer,
}: {
  block: Extract<MessageBlock, { kind: "ask" }>;
  /** The item the card is drawn in, which keys its edit sheet. */
  cardId: string;
  cardBotId: string;
  canAnswer: boolean;
  viewerUserId?: string;
  actionProps: MessageActionProps;
  onAnswer: (answer: string, edits?: SpawnBotEdits) => Promise<void>;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const approval = isApprovalAskBlock(block);
  // A routine card, proposed by the bot or confirming one set up, shows what it creates
  // instead of the plain-text detail.
  const routineCard = approval ? block.routine : undefined;
  // The row above already names the bot; the card only repeats itself for a
  // consequential approval, name-less. A question with fixed options or a
  // routine card opens with no header.
  const header = approval && !routineCard ? { who: t("Needs your call") } : undefined;
  const created = block.created;
  const routineSettled = (): ReactNode => {
    if (!created) {
      switch (routineCardSettlement(block)) {
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
            pathname: "/bot-routine",
            params: { botId: cardBotId, routineId: created.id },
          })
        }
        style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}
      >
        <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("meta") }}>
          {block.confirms === "updated" ? t("Routine updated") : t("Routine created")} ·{" "}
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
    block.status === "answered"
      ? routineCard
        ? routineSettled()
        : formatApprovalAnswer(block.answer, block.actions, approval)
      : !canAnswer
        ? t("No longer active")
        : undefined;
  return (
    <FramedBlock
      header={header ? { ...header, dot: answeredLine === undefined } : undefined}
      question={<Text {...actionProps}>{block.text}</Text>}
      consequence={routineCard ? undefined : block.detail}
      answered={answeredLine}
      actions={
        answeredLine === undefined ? (
          <AskActions
            actions={block.actions ?? []}
            approval={approval}
            consequential={!routineCard}
            allowFreeText={!approval}
            accessibilityActions={actionProps.accessibilityActions}
            onAccessibilityAction={actionProps.onAccessibilityAction}
            onAnswer={(answer) => onAnswer(answer)}
            onEdit={
              block.spawnBot && canAnswer && canEditSpawnBotCard(block.spawnBot, viewerUserId)
                ? () =>
                    openSpawnBotEdit(router, {
                      messageId: cardId,
                      spawnBot: block.spawnBot!,
                      submit: (edits) => onAnswer("allow", edits),
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
  );
}

const NO_ACTIONS: MessageActionProps = { onLongPress: () => {} };

/** A session a row opens in its sheet: the helper's or the routine's own story. */
type OpenedSession = { title: string; load: () => Promise<SessionEntry[]> };

/**
 * Every row that is not a message: a run, a helper, a routine, the bots messaging each other, a
 * divider, an approval, a note. The thread and a session's sheet draw the same rows; the sheet
 * passes `readOnly`, which leaves out what would leave it.
 */
const ItemRow = memo(function ItemRow({
  row,
  botId,
  groupId,
  botName,
  bots,
  members,
  isNew,
  canAnswer,
  viewerUserId,
  onAnswer,
  readOnly = false,
}: {
  row: ThreadRow;
  /** The bot a row with no author of its own is about: the thread's bot. */
  botId: string;
  groupId?: string;
  botName?: string;
  bots: MobileBot[];
  members?: MobileSnapshot["members"];
  isNew: boolean;
  canAnswer: boolean;
  viewerUserId?: string;
  onAnswer?: (card: CardTarget, answer: string, edits?: SpawnBotEdits) => Promise<void>;
  readOnly?: boolean;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const [session, setSession] = useState<OpenedSession | null>(null);
  const { item } = row;
  const botColorOf = (id: string | undefined) =>
    bots.find((bot) => bot.id === id)?.color ??
    members?.find((member) => member.botId === id)?.color ??
    tokens.mutedForeground;
  const avatarOf = (id: string | undefined) => ({
    color: botColorOf(id),
    identity: id,
    shapeSeed: members?.find((member) => member.botId === id)?.shapeSeed,
  });
  const openPeerMessages = readOnly
    ? undefined
    : (ownBotId: string, peerBotId: string, peer: string) =>
        router.push({
          pathname: "/peer-messages",
          params: {
            botId: ownBotId,
            botName: memberName(members, ownBotId) ?? botName ?? "",
            botColor: botColorOf(ownBotId),
            botShapeSeed: avatarOf(ownBotId).shapeSeed?.toString() ?? "",
            peerBotId,
            peerBotName: peer,
            peerColor: botColorOf(peerBotId),
            peerShapeSeed: avatarOf(peerBotId).shapeSeed?.toString() ?? "",
          },
        });
  const body = (() => {
    switch (item.kind) {
      case "message":
        return null;
      case "run":
        return <RunRow item={item} />;
      case "subagent": {
        const title = item.name || t("subagent");
        if (item.status === "running") {
          return <TaskCard title={title} state="running" meta={item.task} streaming />;
        }
        return (
          <TaskCard
            title={title}
            state={item.status === "failed" ? "failed" : "done"}
            meta={item.model.id}
            body={item.result}
            onOpen={() =>
              setSession({
                title,
                load: () =>
                  rpc<{ entries: SessionEntry[] }>("sessions/entries", {
                    sessionId: item.sessionId,
                  }).then((result) => result.entries),
              })
            }
          />
        );
      }
      case "routine": {
        const handoffFor = (run: RoutineLineRun): RoutineHandoff | undefined => {
          const sent = run.sentTo;
          if (!sent) return undefined;
          const peerBotId = sent.peer.kind === "bot" ? sent.peer.botId : undefined;
          return {
            receipt: <BotAvatar {...avatarOf(peerBotId)} size={sizes.receipt} still />,
            avatars: (
              <StackedAvatars
                items={[avatarOf(sent.botId), avatarOf(peerBotId)]}
                size={sizes.interstitial}
                still
              />
            ),
            label: t("Messaged {peer}", { peer: sent.peer.name }),
            onPress:
              openPeerMessages && peerBotId
                ? () => openPeerMessages(sent.botId, peerBotId, sent.peer.name)
                : undefined,
          };
        };
        const openRun = (run: RoutineLineRun) =>
          setSession({
            title: run.item.name,
            load: () =>
              rpc<{ entries: SessionEntry[] }>("runs/entries", { runId: run.item.runId }).then(
                (result) => result.entries,
              ),
          });
        const role: RoutineLineRole = row.routine ?? { kind: "run", run: { item, latest: true } };
        return role.kind === "group" ? (
          <RoutineGroup runs={role.runs} handoffFor={handoffFor} onOpen={openRun} />
        ) : (
          <RoutineRunLine run={role.run} handoff={handoffFor(role.run)} onOpen={openRun} />
        );
      }
      case "handoff": {
        const from = memberName(members, item.fromBotId) ?? t("bot");
        const to = memberName(members, item.toBotId) ?? t("bot");
        const label = t("{from} messaged {to}", { from, to });
        return <HandoffDivider>{item.text ? `${label} · ${item.text}` : label}</HandoffDivider>;
      }
      case "botMessage": {
        const sent = item.direction === "sent";
        const ownBotId = sent ? item.botId : botId;
        const peerBotId = item.peer.kind === "bot" ? item.peer.botId : undefined;
        const card = botMessageCard(item);
        const peerThread = readOnly ? null : card.peerThread;
        const pair = sent ? [ownBotId, peerBotId] : [peerBotId, ownBotId];
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
            accessibilityLabel={card.label}
            avatars={<StackedAvatars items={pairItems} size={sizes.interstitial} still />}
            hitSlop={{ top: 5, bottom: 5, left: 8, right: 8 }}
            style={card.muted ? { opacity: 0.6 } : undefined}
            onPress={
              openPeerMessages && peerBotId
                ? () => openPeerMessages(ownBotId, peerBotId, item.peer.name)
                : undefined
            }
          >
            {card.before}
            {peerThread ? (
              <Text accessibilityRole="link" onPress={() => router.push(peerThread)}>
                {card.peer}
              </Text>
            ) : (
              card.peer
            )}
            {card.after}
          </Interstitial>
        );
      }
      case "divider":
        return <DividerRow reason={item.reason} />;
      case "effect": {
        const { card, runId } = item;
        if (!card) return null;
        return (
          <ApprovalCard
            block={card}
            cardId={item.id}
            cardBotId={item.botId ?? botId}
            canAnswer={!readOnly && canAnswer && Boolean(runId)}
            viewerUserId={viewerUserId}
            actionProps={NO_ACTIONS}
            onAnswer={async (answer, edits) => {
              if (runId) await onAnswer?.({ runId, entryId: item.id }, answer, edits);
            }}
          />
        );
      }
      case "note":
        return <NoteRow item={item} isNew={isNew} />;
    }
  })();
  return (
    <>
      {body}
      {session ? (
        <SessionSheet
          session={session}
          botId={botId}
          groupId={groupId}
          bots={bots}
          members={members}
          onClose={() => setSession(null)}
        />
      ) : null}
    </>
  );
});

/** A run as one quiet line: its model and how it went, opening to its duration and tokens. */
function RunRow({ item }: { item: RunItem }) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const outcome = item.finished?.outcome;
  const state = !outcome ? "running" : outcome.status;
  const word = stateWord(state === "completed" ? "done" : state);
  const symbol = ROUTINE_STATE_SYMBOL[state];
  const statusStyle = {
    color: state === "failed" ? tokens.destructive : tokens.mutedForeground,
    ...nativeTextStyle("label", { weight: 500 }),
  };
  const detail = item.finished
    ? `${formatShortDuration(item.finished.durationMs)} · ${t("{tokens} tokens", {
        tokens: (
          item.finished.outcome.usage.inputTokens + item.finished.outcome.usage.outputTokens
        ).toLocaleString(dateLocaleForUi()),
      })}`
    : null;
  return (
    <View>
      <Pressable
        accessibilityRole={detail ? "button" : undefined}
        accessibilityLabel={[item.model.id, word].join(", ")}
        accessibilityState={detail ? { expanded: open } : undefined}
        disabled={!detail}
        onPress={() => setOpen(!open)}
        unstable_pressDelay={130}
        style={({ pressed }) => ({
          minHeight: 32,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginHorizontal: -8,
          paddingHorizontal: 8,
          borderRadius: radii.row,
          backgroundColor: pressed ? tokens.secondary : "transparent",
        })}
      >
        <NativeSymbol
          ios={symbol.ios}
          android={symbol.android}
          size={13}
          color={state === "failed" ? tokens.destructive : tokens.mutedForeground}
        />
        <Text
          numberOfLines={1}
          style={{ flex: 1, color: tokens.mutedForeground, ...nativeTextStyle("label") }}
        >
          {item.model.id}
        </Text>
        {state === "running" ? (
          <ShimmerText style={statusStyle}>{word}</ShimmerText>
        ) : (
          <Text style={statusStyle}>{word}</Text>
        )}
        <View style={{ width: 14, alignItems: "center" }}>
          {detail ? <Disclosure open={open} /> : null}
        </View>
      </Pressable>
      {open && detail ? (
        <Text
          style={{
            marginStart: 21,
            color: tokens.mutedForeground,
            ...nativeTextStyle("time"),
            fontVariant: ["tabular-nums"],
          }}
        >
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/** Where the history was summarized, edited back or cleared: a hairline and a word. */
function DividerRow({ reason }: { reason: Extract<ThreadItem, { kind: "divider" }>["reason"] }) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const rule = (
    <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: tokens.border }} />
  );
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {rule}
      <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("label") }}>
        {reason === "compaction"
          ? t("Earlier messages summarized")
          : reason === "rewind"
            ? t("Message edited")
            : t("Conversation cleared")}
      </Text>
      {rule}
    </View>
  );
}

/** A note between messages: a channel's own words, or a skill the bot learned or changed. */
function NoteRow({ item, isNew }: { item: NoteItem; isNew: boolean }) {
  const router = useRouter();
  if (item.type === "system.note") {
    return <Interstitial avatars={null}>{item.payload.text}</Interstitial>;
  }
  if (item.type === "skill.learnt") {
    const { skillId, name, change } = item.payload;
    return (
      <BubbleMeta lines={[skillLineMeta({ skillId, name, change }, isNew, router)]} standalone />
    );
  }
  return null;
}

/**
 * A child session read whole in a sheet, through the same rows as the thread and with nothing to
 * act on: a helper's own work, or a routine run's story with the person's answers.
 */
function SessionSheet({
  session,
  botId,
  groupId,
  bots,
  members,
  onClose,
}: {
  session: OpenedSession;
  botId: string;
  groupId?: string;
  bots: MobileBot[];
  members?: MobileSnapshot["members"];
  onClose: () => void;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const showSteps = useDisplayAgentSteps();
  const [entries, setEntries] = useState<SessionEntry[] | "failed" | null>(null);
  useEffect(() => {
    let open = true;
    session.load().then(
      (loaded) => open && setEntries(loaded),
      () => open && setEntries("failed"),
    );
    return () => {
      open = false;
    };
  }, [session]);
  const rows = useMemo(
    () =>
      Array.isArray(entries)
        ? projectThreadView(entries, { rendersNothing: (item) => drawsNothing(item, showSteps) })
            .rows
        : [],
    [entries, showSteps],
  );
  return (
    <PreviewSheet title={session.title} onClose={onClose}>
      <View style={{ paddingTop: 16 }}>
        {entries === null ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
        {entries === "failed" ? (
          <Text style={{ color: tokens.destructive, ...nativeTextStyle("meta") }}>
            {t("Could not load this chat")}
          </Text>
        ) : null}
        {rows.map((row, index) => (
          <View
            key={row.item.id}
            style={{ marginTop: index === 0 ? 0 : row.firstOfGroup ? GROUP_GAP : WITHIN_GROUP_GAP }}
          >
            {row.item.kind === "message" ? (
              <MessageBubble
                botId={botId}
                groupId={groupId}
                message={row.item}
                canAnswer={false}
                onAnswer={async () => {}}
                onOpenBot={() => {}}
                onPreviewMarkdown={() => {}}
                actionProps={NO_ACTIONS}
                isNew={false}
              />
            ) : (
              <ItemRow
                row={row}
                botId={botId}
                groupId={groupId}
                bots={bots}
                members={members}
                isNew={false}
                canAnswer={false}
                readOnly
              />
            )}
          </View>
        ))}
      </View>
    </PreviewSheet>
  );
}

/** The skill lines under a bot's message: what it learned or updated opens the skill, a deleted one only shows. */
function useSkillLines(message: MobileMessage, isNew: boolean): BotBubbleMeta[] {
  useI18n();
  const router = useRouter();
  const skillLines = skillSourcesOf(message.blocks);
  const skillsAtMount = useRef(skillLines.length);
  const skillsLive = isNew || skillLines.length > skillsAtMount.current;
  return skillLines.map((line) => skillLineMeta(line, skillsLive, router));
}

/** One skill line: what it learned or updated opens the skill, a deleted one only shows. */
function skillLineMeta(
  line: { skillId: string; name: string; change: "learned" | "updated" | "deleted" },
  live: boolean,
  router: ReturnType<typeof useRouter>,
): BotBubbleMeta {
  return {
    id: `${line.skillId}:${line.change}`,
    label:
      line.change === "learned"
        ? t("Skill learned · {name}", { name: line.name })
        : line.change === "updated"
          ? t("Skill updated · {name}", { name: line.name })
          : t("Skill deleted · {name}", { name: line.name }),
    icon: { ios: "book", android: "book-outline" },
    onPress:
      line.change === "deleted"
        ? undefined
        : () =>
            void skillLineRoute(line, () =>
              rpc<AgentSkillCatalogEntry[]>("agentSkills/list").catch(() => []),
            ).then((route) => router.push(route)),
    live,
  };
}

/** The skill lines of a message whose link card took its bubble's place, standing alone under the card. */
function CardSkillLines({ message, isNew }: { message: MobileMessage; isNew: boolean }) {
  const lines = useSkillLines(message, isNew);
  return lines.length > 0 ? <BubbleMeta lines={lines} standalone /> : null;
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
  /** Absent in a sheet that reads a session, which opens nothing else. */
  onPress?: () => void;
}

/** How long a page sheet takes to slide away before the next screen can push. */
const SHEET_DISMISS_MS = 350;

/** What a tap inside a sheet opens, once the sheet has closed. */
function afterSheet(close: () => void, open: () => void): () => void {
  return () => {
    close();
    setTimeout(open, SHEET_DISMISS_MS);
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
 * word, then fixed receipt and disclosure slots so the columns line up down a
 * run of routines. Opening it shows the report under a hairline rail and,
 * centred as every exchange between bots is, the message it then sent; the
 * report opens the run's whole story in a sheet. A line with nothing to show
 * opens that story at once. A failed latest run opens on its report.
 */
function RoutineRunLine({
  run,
  handoff,
  onOpen,
  nested = false,
  withDay = false,
}: {
  run: RoutineLineRun;
  handoff?: RoutineHandoff;
  onOpen: (run: RoutineLineRun) => void;
  /** A line inside an open group: smaller symbol, the time in place of the name. */
  nested?: boolean;
  withDay?: boolean;
}) {
  const tokens = mobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const { item } = run;
  const state = item.finished?.status ?? "running";
  const report = item.finished?.result.trim() || undefined;
  const failed = state === "failed";
  const expands = Boolean(report || handoff);
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  // Only a routine's latest failed run opens on its own: older ones stay
  // folded so a thread of past failures is not a wall of reports.
  const expanded = expands && (manualExpanded ?? Boolean(report && run.latest && failed));
  const fromTap = useRef(false);
  // At accessibility text sizes the time and status move under the name.
  const stacked = PixelRatio.getFontScale() > 1.35;
  const symbolColor =
    state === "completed" ? tokens.success : failed ? tokens.destructive : tokens.mutedForeground;
  const statusLabel =
    state === "running"
      ? t("Running")
      : state === "completed"
        ? t("Completed")
        : failed
          ? t("Failed")
          : t("Cancelled");
  const statusStyle = {
    color: failed ? tokens.destructive : tokens.mutedForeground,
    ...nativeTextStyle("label", { weight: 500 }),
  };
  const time = routineTime(item.ts, withDay);
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
      {state === "running" ? (
        <ShimmerText style={statusStyle}>{statusLabel}</ShimmerText>
      ) : (
        <Text style={statusStyle}>{statusLabel}</Text>
      )}
    </>
  );
  const symbol = ROUTINE_STATE_SYMBOL[state];
  const accessibilityLabel = [item.name, statusLabel, time, handoff?.label]
    .filter(Boolean)
    .join(", ");
  return (
    <View>
      <Pressable
        accessible
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={expands ? { expanded } : undefined}
        onPress={() => {
          if (!expands) {
            onOpen(run);
            return;
          }
          fromTap.current = true;
          setManualExpanded(!expanded);
        }}
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
          backgroundColor: pressed ? tokens.secondary : "transparent",
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
            {nested && time ? time : item.name}
          </Text>
          {stacked ? <View style={{ flexDirection: "row", gap: 8 }}>{trailing}</View> : null}
        </View>
        {stacked ? null : trailing}
        {/* Fixed slots, kept when empty, so the columns line up down a run of routines. */}
        <View style={{ width: sizes.receipt, alignItems: "center" }}>
          {handoff && !expanded ? handoff.receipt : null}
        </View>
        <View style={{ width: 14, alignItems: "center" }}>
          {expands ? <Disclosure open={expanded} /> : null}
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
          {report ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Report, {name}", { name: item.name })}
              accessibilityHint={t("Opens in full")}
              onPress={() => onOpen(run)}
              unstable_pressDelay={130}
            >
              <ClippedPreview
                maxHeight={REPORT_PREVIEW_HEIGHT}
                fadeColor={tokens.background}
                onOpen={() => onOpen(run)}
                accessibilityLabel={t("Report, {name}", { name: item.name })}
              >
                <ChatMarkdown
                  allowImages={false}
                  palette={tokens}
                  colorScheme={colorScheme}
                  bleed={18}
                >
                  {truncateMarkdownForRender(report)}
                </ChatMarkdown>
              </ClippedPreview>
            </Pressable>
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
  onOpen,
}: {
  runs: RoutineLineRun[];
  handoffFor: (run: RoutineLineRun) => RoutineHandoff | undefined;
  onOpen: (run: RoutineLineRun) => void;
}) {
  const tokens = mobileTokens();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const fromTap = useRef(false);
  const first = runs[0]!;
  const last = runs.at(-1)!;
  const spansDays = !sameLocalDay(first.item.ts, last.item.ts);
  const range = routineRange(first.item.ts, last.item.ts);
  const cancelled = runs.filter((run) => run.item.finished?.status === "cancelled").length;
  const statusLabel = cancelled ? t("{count} cancelled", { count: cancelled }) : t("Completed");
  const countLabel = t("{count} runs", { count: runs.length });
  const handoffs = runs.map(handoffFor);
  const receipts = new Set(
    runs.map(({ sentTo }) => (sentTo?.peer.kind === "bot" ? sentTo.peer.botId : undefined)),
  );
  const receipt =
    receipts.size === 1 && !receipts.has(undefined) ? handoffs.find(Boolean)?.receipt : null;
  const inSheet = runs.length > GROUP_INLINE_MAX;
  const lines = (
    <View style={{ marginStart: 28 }}>
      {runs.map((run, index) => (
        <RoutineRunLine
          key={run.item.id}
          run={run}
          handoff={handoffs[index]}
          onOpen={onOpen}
          nested
          withDay={spansDays}
        />
      ))}
    </View>
  );
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[first.item.name, countLabel, range, statusLabel].join(", ")}
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
          {`${first.item.name} `}
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
        <View style={{ width: 14, alignItems: "center" }}>
          <Disclosure open={open && !inSheet} />
        </View>
      </Pressable>
      <Expandable open={open && !inSheet} fromTap={fromTap}>
        {lines}
      </Expandable>
      {open && inSheet ? (
        <PreviewSheet title={first.item.name} onClose={() => setOpen(false)}>
          <View style={{ paddingTop: 8 }}>
            {runs.map((run, index) => {
              const dayStarts = index === 0 || !sameLocalDay(runs[index - 1]!.item.ts, run.item.ts);
              const handoff = handoffs[index];
              const close = () => setOpen(false);
              return (
                <View key={run.item.id}>
                  {dayStarts ? (
                    <Text
                      style={{
                        marginTop: index === 0 ? 8 : 16,
                        marginBottom: 4,
                        color: tokens.mutedForeground,
                        ...nativeTextStyle("label", { weight: 500 }),
                      }}
                    >
                      {threadTimeMarkerLabel(run.item.ts, {
                        locale: dateLocaleForUi(),
                        today: t("Today"),
                        yesterday: t("Yesterday"),
                        withTime: false,
                      })}
                    </Text>
                  ) : null}
                  <RoutineRunLine
                    run={run}
                    handoff={
                      handoff?.onPress
                        ? { ...handoff, onPress: afterSheet(close, handoff.onPress) }
                        : handoff
                    }
                    onOpen={(opened) => afterSheet(close, () => onOpen(opened))()}
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
  onOpen,
}: {
  title: string;
  state: TaskCardState;
  meta?: string;
  /** Markdown result, shown as a preview and whole in the sheet. */
  body?: string;
  streaming?: boolean;
  /** Opens the task's own session in place of the sheet with its brief and result. */
  onOpen?: () => void;
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
  const open = onOpen ?? (body || meta ? () => setSheetOpen(true) : undefined);
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
  const quote = replyQuote(message, replyPreview);
  if (!quote) return null;
  return (
    <Text
      numberOfLines={2}
      style={{
        marginBottom: 6,
        color: tokens.mutedForeground,
        ...nativeTextStyle("meta"),
      }}
    >
      {quote}
    </Text>
  );
}

/** What a reply shows of the message it answers: the excerpt it quoted, or that message's text. */
function replyQuote(message: MobileMessage, replyPreview: MobileMessage | undefined): string {
  const replyTo = message.role === "user" ? message.replyTo : undefined;
  if (!replyTo) return "";
  if (replyTo.quote) return `“${replyTo.quote}”`;
  return replyPreview ? previewMessageText(replyPreview) : "";
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
  meta,
}: {
  message: MobileMessage;
  replyPreview?: MobileMessage;
  actionProps: MessageActionProps;
  mono?: boolean;
  /** The skill lines under its last bubble. */
  meta?: readonly BotBubbleMeta[];
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
        meta={meta}
      >
        <ChatMarkdown
          palette={tokens}
          colorScheme={colorScheme}
          streaming={isLiveMessage(message)}
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
