import { ChatMarkdown, truncateMarkdownForRender } from "@rakazo/chat-ui/native";
import type { BotActivityOutput, RunActivityRow, RunRecap, RunStatus } from "@rakazo/contracts";
import type { ActivityItem, RecapBody, RecapRead } from "@rakazo/core";
import {
  dayMarkers,
  foldActivity,
  recapView,
  reduceActivity,
  runTitle,
  threadTimeMarkerLabel,
} from "@rakazo/core";
import { radii } from "@rakazo/ui-tokens";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import type { ComponentProps } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import type { StateWord } from "../../lib/bot-activity";
import { failureReason, runOpening, stateWord } from "../../lib/bot-activity";
import { useDebugMode } from "../../lib/debug-mode";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { nativeTextStyle } from "../../lib/typography";
import { NativeSymbol } from "../native-symbol";
import { ShimmerText } from "../shimmer-text";
import { Group, LoadFailed, LoadingRows, QuietLine } from "./kit";

/**
 * A bot's activity, or one routine's runs, newest first, a page at a time. Reads again when a run
 * ends (`epoch`) and whenever the page comes back into view. With `allRuns`, every run of the bot.
 */
function useBotActivity(
  botId: string,
  routineId: string | undefined,
  allRuns: boolean,
  epoch: number,
) {
  const [read, dispatch] = useReducer(reduceActivity, { kind: "loading" });
  const readRef = useRef(read);
  readRef.current = read;
  // Each first-page read bumps the token, so an older answer, or an earlier page asked for before it, is dropped.
  const token = useRef(0);

  const load = useCallback(async () => {
    const mine = ++token.current;
    try {
      const page = await rpc<BotActivityOutput>("bots/activity", {
        botId,
        routineId,
        allRuns: allRuns || undefined,
      });
      if (mine === token.current) dispatch({ type: "first", page });
    } catch {
      if (mine === token.current) dispatch({ type: "first-failed" });
    }
  }, [botId, routineId, allRuns]);

  const showEarlier = useCallback(async () => {
    const current = readRef.current;
    if (current.kind !== "ready" || !current.next || current.earlier === "loading") return;
    const mine = token.current;
    const cursor = current.next;
    dispatch({ type: "earlier-started" });
    try {
      const page = await rpc<BotActivityOutput>("bots/activity", {
        botId,
        routineId,
        allRuns: allRuns || undefined,
        cursor,
      });
      if (mine === token.current) dispatch({ type: "earlier", page });
    } catch {
      if (mine === token.current) dispatch({ type: "earlier-failed" });
    }
  }, [botId, routineId, allRuns]);

  const retry = useCallback(() => {
    dispatch({ type: "retry" });
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load, epoch]),
  );

  return { read, showEarlier, retry };
}

/** What a run left in its thread, read when its line opens and again once its status moves. */
function useRunRecap(runId: string, status: RunStatus, open: boolean) {
  const [read, setRead] = useState<RecapRead | null>(null);
  // A new status makes what was read stale.
  useEffect(() => setRead(null), [status]);
  const load = useCallback(() => {
    setRead({ kind: "loading" });
    rpc<RunRecap>("runs/recap", { runId }).then(
      (recap) => setRead({ kind: "ready", recap }),
      () => setRead({ kind: "failed" }),
    );
  }, [runId]);
  useEffect(() => {
    if (open && read === null) load();
  }, [open, read, load]);
  return { read, retry: load };
}

/**
 * Which run lines are open, kept by the list: a run that ends moves from the top to its day and
 * is drawn anew there, and must stay open.
 */
const OpenRuns = createContext<{ open: ReadonlySet<string>; toggle: (runId: string) => void }>({
  open: new Set(),
  toggle: () => {},
});

function useOpenRuns() {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((runId: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  }, []);
  return useMemo(() => ({ open, toggle }), [open, toggle]);
}

type LineSymbol = { ios: string; android: ComponentProps<typeof NativeSymbol>["android"] };

/** Each run status as a symbol, a colour that only confirms it, and one word. */
const RUN_STATE: Record<
  RunStatus,
  { word: StateWord; symbol: LineSymbol; tone: "success" | "destructive" | "muted" }
> = {
  queued: { word: "waiting", symbol: { ios: "clock", android: "time-outline" }, tone: "muted" },
  leased: {
    word: "running",
    symbol: { ios: "circle.dotted", android: "ellipsis-horizontal-circle-outline" },
    tone: "muted",
  },
  running: {
    word: "running",
    symbol: { ios: "circle.dotted", android: "ellipsis-horizontal-circle-outline" },
    tone: "muted",
  },
  waiting_input: {
    word: "waiting",
    symbol: { ios: "clock", android: "time-outline" },
    tone: "muted",
  },
  waiting_takeover: {
    word: "waiting",
    symbol: { ios: "clock", android: "time-outline" },
    tone: "muted",
  },
  completed: {
    word: "done",
    symbol: { ios: "checkmark.circle.fill", android: "checkmark-circle" },
    tone: "success",
  },
  failed: {
    word: "failed",
    symbol: { ios: "xmark.circle.fill", android: "close-circle" },
    tone: "destructive",
  },
  cancelled: {
    word: "cancelled",
    symbol: { ios: "stop.circle", android: "stop-circle-outline" },
    tone: "muted",
  },
};

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(dateLocaleForUi(), { hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

function itemKey(item: ActivityItem): string {
  switch (item.kind) {
    case "run":
      return item.row.runId;
    case "folded":
      return `folded-${item.runs[0]?.runId}`;
    case "routine_created":
      return `routine-${item.routineId}`;
    case "bot_created":
      return `bot-${item.botId}`;
  }
}

/** Absent on an archived bot's page: its chat cannot be opened. */
type OpenRun = ((row: RunActivityRow) => void) | undefined;

type ActivityTabProps = {
  botId: string;
  routineId?: string;
  epoch: number;
  /** Opens the run's chat, at the message its recap came from when there is one. */
  onOpenRun?: OpenRun;
  onOpenRoutine?: (routineId: string) => void;
  onWriteInstructions?: () => void;
};

/**
 * The bot's routine runs, the routines it was given and its own creation, grouped by day; with
 * `routineId`, only that routine's runs. A run opens its recap in place, with a way into the chat;
 * a routine's creation opens the routine. With `onWriteInstructions` (a bot with no instructions
 * yet) its creation offers to write them. In debug mode it lists every run of the bot.
 */
export function ActivityTab(props: ActivityTabProps) {
  const debug = useDebugMode();
  // Pages read under one scope must not mix with the other's.
  return <ActivityList key={debug ? "all" : "routines"} allRuns={debug} {...props} />;
}

function ActivityList({
  botId,
  routineId,
  allRuns,
  epoch,
  onOpenRun,
  onOpenRoutine,
  onWriteInstructions,
}: ActivityTabProps & { allRuns: boolean }) {
  const styles = useThemedStyles(createActivityStyles);
  const { t } = useI18n();
  const { read, showEarlier, retry } = useBotActivity(botId, routineId, allRuns, epoch);
  const openRuns = useOpenRuns();

  if (read.kind !== "ready" || read.entries.length === 0) {
    return (
      <Group>
        {read.kind === "loading" ? (
          <LoadingRows />
        ) : read.kind === "failed" ? (
          <LoadFailed onRetry={retry} />
        ) : (
          <QuietLine>{t("No activity yet")}</QuietLine>
        )}
      </Group>
    );
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // A routine's own page lists every run: folding would hide the history it is there to show.
  const days = dayMarkers(foldActivity(read.entries, { fold: !routineId }), timeZone);
  return (
    <OpenRuns.Provider value={openRuns}>
      <View style={styles.list}>
        {days.map(({ day, at, items }) => (
          <Group
            key={day ?? "now"}
            label={
              day
                ? threadTimeMarkerLabel(at, {
                    locale: dateLocaleForUi(),
                    today: t("Today"),
                    yesterday: t("Yesterday"),
                    withTime: false,
                  })
                : undefined
            }
          >
            {items.map((item) => (
              <ActivityLine
                key={itemKey(item)}
                item={item}
                oneRoutine={Boolean(routineId)}
                onOpenRun={onOpenRun}
                onOpenRoutine={onOpenRoutine}
                onWriteInstructions={onWriteInstructions}
              />
            ))}
          </Group>
        ))}
        {read.next ? (
          read.earlier === "failed" ? (
            <LoadFailed onRetry={() => void showEarlier()} />
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={read.earlier === "loading"}
              onPress={() => void showEarlier()}
              style={styles.earlier}
            >
              <Text style={styles.quietText}>{t("Show earlier")}</Text>
            </Pressable>
          )
        ) : null}
      </View>
    </OpenRuns.Provider>
  );
}

function ActivityLine({
  item,
  oneRoutine,
  onOpenRun,
  onOpenRoutine,
  onWriteInstructions,
}: {
  item: ActivityItem;
  oneRoutine: boolean;
  onOpenRun: OpenRun;
  onOpenRoutine?: (routineId: string) => void;
  onWriteInstructions?: () => void;
}) {
  const { t } = useI18n();
  switch (item.kind) {
    case "run":
      return <RunLine row={item.row} oneRoutine={oneRoutine} onOpenRun={onOpenRun} />;
    case "folded":
      return <FoldedLine name={item.name} runs={item.runs} onOpenRun={onOpenRun} />;
    case "routine_created":
      return (
        <CreationLine
          symbol={{ ios: "calendar.badge.plus", android: "calendar-outline" }}
          name={item.routineName}
          detail={
            item.byBotName
              ? t("Routine created by {by}", { by: item.byBotName })
              : t("Routine created")
          }
          at={item.createdAt}
          onPress={onOpenRoutine && (() => onOpenRoutine(item.routineId))}
        />
      );
    case "bot_created":
      return (
        <CreationLine
          symbol={{ ios: "sparkles", android: "sparkles-outline" }}
          name={t("{name} created", { name: item.botName })}
          at={item.createdAt}
          action={
            onWriteInstructions && {
              label: t("Write its first instructions"),
              onPress: onWriteInstructions,
            }
          }
        />
      );
  }
}

/** On a routine's own page every line is that routine: lines lead with their time instead. */
function RunLine({
  row,
  oneRoutine = false,
  onOpenRun,
}: {
  row: RunActivityRow;
  oneRoutine?: boolean;
  onOpenRun: OpenRun;
}) {
  const styles = useThemedStyles(createActivityStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const runs = useContext(OpenRuns);
  const open = runs.open.has(row.runId);
  const recap = useRunRecap(row.runId, row.status, open);
  const view = recapView(recap.read, {
    failed: row.status === "failed",
    sourceMessageId: row.sourceMessageId,
  });
  const state = RUN_STATE[row.status];
  const word = stateWord(state.word);
  const reason = row.status === "failed" ? failureReason(row.failureKind) : null;
  const time = formatTime(row.createdAt);
  const title = oneRoutine ? time : runTitle(row, { routine: t("Routine"), message: t("Message") });
  const tone =
    state.tone === "success"
      ? tokens.success
      : state.tone === "destructive"
        ? tokens.destructive
        : tokens.mutedForeground;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[title, reason, word, oneRoutine ? null : time]
          .filter(Boolean)
          .join(", ")}
        onPress={() => runs.toggle(row.runId)}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      >
        <NativeSymbol
          ios={state.symbol.ios}
          android={state.symbol.android}
          size={19}
          color={tone}
        />
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
            {title}
          </Text>
          {reason ? (
            <Text style={styles.detail} numberOfLines={1}>
              {reason}
            </Text>
          ) : null}
        </View>
        {oneRoutine ? null : <Text style={styles.time}>{time}</Text>}
        {state.word === "running" ? (
          <ShimmerText style={styles.word}>{word}</ShimmerText>
        ) : (
          <Text style={[styles.word, state.word === "failed" && styles.failed]}>{word}</Text>
        )}
        <Disclosure visible open={open} />
      </Pressable>
      {open ? (
        <RunRecapBody
          body={view.body}
          onRetry={recap.retry}
          onOpenChat={
            onOpenRun && view.opensChat
              ? () => onOpenRun({ ...row, sourceMessageId: view.jumpTo })
              : undefined
          }
        />
      ) : null}
    </View>
  );
}

/** A run's recap under an `outline` rail: what it wrote, then the way into the chat. */
function RunRecapBody({
  body,
  onRetry,
  onOpenChat,
}: {
  body: RecapBody;
  onRetry: () => void;
  onOpenChat: (() => void) | undefined;
}) {
  const styles = useThemedStyles(createActivityStyles);
  const { t } = useI18n();
  return (
    <View style={styles.recap}>
      {body.kind === "loading" ? (
        <View accessibilityState={{ busy: true }} style={styles.loading}>
          <View style={[styles.bone, { width: "80%" }]} />
          <View style={[styles.bone, { width: "60%" }]} />
        </View>
      ) : body.kind === "failed" ? (
        <Pressable accessibilityRole="button" onPress={onRetry}>
          <Text style={styles.quietText}>{t("Could not load · Retry")}</Text>
        </Pressable>
      ) : body.kind === "text" ? (
        <RecapText text={body.text} />
      ) : body.kind === "no_report" ? (
        <Text style={styles.quietText}>{t("No report")}</Text>
      ) : null}
      {onOpenChat ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          onPress={onOpenChat}
          style={styles.action}
        >
          <Text style={styles.actionText}>{t("Open in chat")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Eight lines of the 23 pt body before "Show more", only when that hides at least three more. */
const LINE_HEIGHT = 23;
const RECAP_PREVIEW_HEIGHT = 8 * LINE_HEIGHT;
const FADE_HEIGHT = 56;

/** A recap in the chat's own markdown, without remote images, cut with "Show more" when long. */
function RecapText({ text }: { text: string }) {
  const styles = useThemedStyles(createActivityStyles);
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const [height, setHeight] = useState(0);
  const [more, setMore] = useState(false);
  const cut = height > RECAP_PREVIEW_HEIGHT + 3 * LINE_HEIGHT && !more;
  return (
    <>
      <View style={cut ? { height: RECAP_PREVIEW_HEIGHT, overflow: "hidden" } : undefined}>
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <ChatMarkdown allowImages={false} palette={tokens} colorScheme={colorScheme}>
            {truncateMarkdownForRender(text)}
          </ChatMarkdown>
        </View>
        {cut ? (
          <Svg
            pointerEvents="none"
            width="100%"
            height={FADE_HEIGHT}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          >
            <Defs>
              <LinearGradient id="recap-fade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={tokens.surface} stopOpacity={0} />
                <Stop offset="0.6" stopColor={tokens.surface} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height={FADE_HEIGHT} fill="url(#recap-fade)" />
          </Svg>
        ) : null}
      </View>
      {cut ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => setMore(true)}
          style={styles.action}
        >
          <Text style={styles.actionText}>{t("Show more")}</Text>
        </Pressable>
      ) : null}
    </>
  );
}

function CreationLine({
  symbol,
  name,
  detail,
  at,
  onPress,
  action,
}: {
  symbol: LineSymbol;
  name: string;
  detail?: string;
  at: string;
  onPress?: () => void;
  /** A link as the sub-line, on a line that does not open anything itself. */
  action?: { label: string; onPress: () => void };
}) {
  const styles = useThemedStyles(createActivityStyles);
  const tokens = useMobileTokens();
  const time = formatTime(at);
  return (
    <Pressable
      // A line with a link leaves it its own element for VoiceOver.
      accessible={!action}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={[name, detail, time].filter(Boolean).join(", ")}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.line, pressed && styles.pressed]}
    >
      <NativeSymbol
        ios={symbol.ios}
        android={symbol.android}
        size={17}
        color={tokens.mutedForeground}
      />
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
        {action ? (
          <Text
            accessibilityRole="link"
            onPress={action.onPress}
            suppressHighlighting={false}
            style={[styles.detail, styles.link]}
          >
            {action.label}
          </Text>
        ) : null}
      </View>
      <Text style={styles.time}>{time}</Text>
      <Disclosure visible={Boolean(onPress)} />
    </Pressable>
  );
}

function Disclosure({ visible, open }: { visible: boolean; open?: boolean }) {
  const tokens = useMobileTokens();
  return (
    <View style={{ width: 14, alignItems: "center", opacity: visible ? 1 : 0 }}>
      <View style={open ? { transform: [{ rotate: "90deg" }] } : undefined}>
        <NativeSymbol
          ios="chevron.forward"
          android="chevron-forward"
          size={12}
          weight="semibold"
          color={tokens.mutedForeground}
        />
      </View>
    </View>
  );
}

function FoldedLine({
  name,
  runs,
  onOpenRun,
}: {
  name: string | null;
  runs: RunActivityRow[];
  onOpenRun: OpenRun;
}) {
  const styles = useThemedStyles(createActivityStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const title = name ?? t("Routine");
  const count = t("{count} runs", { count: runs.length });
  const done = stateWord("done");
  const newest = runs[0];
  const time = newest ? formatTime(newest.createdAt) : "";
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={[title, count, done, time].join(", ")}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      >
        <NativeSymbol
          ios="checkmark.circle.fill"
          android="checkmark-circle"
          size={19}
          color={tokens.success}
        />
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {count}
          </Text>
        </View>
        <Text style={styles.time}>{time}</Text>
        <Text style={styles.word}>{done}</Text>
        <Disclosure visible open={open} />
      </Pressable>
      {open ? (
        <View style={styles.folded}>
          {runs.map((row) => (
            <RunLine key={row.runId} row={row} onOpenRun={onOpenRun} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function createActivityStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    list: { gap: 24 },
    line: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    pressed: { backgroundColor: tokens.accent },
    text: { flex: 1, minWidth: 0, gap: 2 },
    name: { color: tokens.foreground, ...nativeTextStyle("composer") },
    detail: { color: tokens.mutedForeground, ...nativeTextStyle("meta", { size: 14 }) },
    link: { textDecorationLine: "underline" },
    time: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("time", { size: 15 }),
      fontVariant: ["tabular-nums"],
    },
    word: {
      minWidth: 44,
      textAlign: "right",
      color: tokens.mutedForeground,
      ...nativeTextStyle("label", { size: 15, weight: 500 }),
    },
    failed: { color: tokens.destructive },
    folded: { marginStart: 28 },
    recap: {
      marginStart: 25,
      marginEnd: 16,
      marginBottom: 14,
      paddingStart: 16,
      borderStartWidth: 1,
      borderStartColor: tokens.outline,
      gap: 10,
    },
    quietText: { color: tokens.mutedForeground, ...nativeTextStyle("meta", { size: 15 }) },
    earlier: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 12 },
    loading: { gap: 8, paddingVertical: 4 },
    bone: { height: 12, borderRadius: radii.chip, backgroundColor: tokens.muted },
    action: { alignSelf: "flex-start" },
    actionText: {
      color: tokens.foreground,
      ...nativeTextStyle("label", { size: 15, weight: 500 }),
    },
  });
}

/** Opens a run's chat from a screen above the chats (see `runOpening`). */
export function useOpenRun(): (row: RunActivityRow) => void {
  const navigation = useNavigation();
  const router = useRouter();
  return (row) => {
    const { via, to } = runOpening(navigation.getState()?.routes ?? [], row);
    router[via](to);
  };
}
