import { useAskCard } from "@rakazo/chat-ui/ask-card";
import { ASK_ANSWER_MAX_LENGTH } from "@rakazo/contracts";
import type { AskCardBlock, AskForm, AskSettledView, Presenter, ViewChange } from "@rakazo/core";
import { motion, radii, sizes } from "@rakazo/ui-tokens";
import { useEffect, useRef, useState } from "react";
import type { LayoutChangeEvent, TextProps } from "react-native";
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { mobileTokens } from "../lib/appearance";
import { answerLines, interruptWhenAway } from "../lib/ask-card";
import { useChatReducedMotion } from "../lib/chat-motion";
import { commitHaptic, selectionHaptic } from "../lib/haptics";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { CapsuleButton, TERTIARY_CAPSULE_HEIGHT } from "./AskActions";
import { FramedBlock } from "./framed-block";
import { NativeSymbol } from "./native-symbol";
import { UserBubble } from "./user-bubble";

/** Room around the card inside its clip for its ring and drop shadow; above, only the ring. */
const BLEED = 28;
const BLEED_TOP = 4;
const FREE = 1e5;
const SPRING = { duration: motion.spring.response, dampingRatio: 1 - motion.spring.bounce };
const fade = (ms: number, delay = 0) =>
  FadeIn.duration(ms).delay(delay).reduceMotion(ReduceMotion.Never);
/** Each arrival waits for what leaves to fade; a stack's step swaps at once, so the card never shows blank. */
const ARRIVALS: Partial<Record<ViewChange["kind"], ReturnType<typeof fade>>> = {
  settle: fade(motion.arrive, motion.fill),
  reopen: fade(motion.arrive, motion.fill),
};
const EXIT = FadeOut.duration(motion.fill).reduceMotion(ReduceMotion.Never);

/**
 * The card keeps its height while its content changes, then springs to the new content's height.
 * Its height is a real layout prop, so the rows above in the inverted thread follow frame by frame.
 */
function useFold(still: boolean) {
  const low = useSharedValue(0);
  const high = useSharedValue(FREE);
  /** Held or springing: until the spring rests, each new measure of the content retargets it. */
  const bound = useSharedValue(false);
  const style = useAnimatedStyle(() => ({ minHeight: low.value, maxHeight: high.value }));
  const [fold] = useState(() => {
    let measured = 0;
    return {
      release() {
        bound.value = false;
        low.value = 0;
        high.value = FREE;
      },
      hold(skip: boolean) {
        if (skip) return;
        bound.value = true;
        low.value = measured;
        high.value = measured;
      },
      onLayout(event: LayoutChangeEvent) {
        measured = event.nativeEvent.layout.height + BLEED_TOP + BLEED;
        if (!bound.value) return;
        low.value = withSpring(measured, SPRING);
        high.value = withSpring(measured, SPRING, (done) => {
          if (!done) return;
          bound.value = false;
          low.value = 0;
          high.value = FREE;
        });
      },
    };
  });
  return { ...fold, style, hold: () => fold.hold(still) };
}

export function QuestionCard({
  block,
  form,
  messageId,
  canAnswer,
  onAnswer,
  questionProps,
}: {
  block: AskCardBlock;
  form: AskForm;
  messageId: string;
  canAnswer: boolean;
  onAnswer: (wire: string) => Promise<void>;
  /** The message's own actions, on the question text and the settled line. */
  questionProps: TextProps;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const fold = useFold(useChatReducedMotion());
  const { release } = fold;
  const [leaving, setLeaving] = useState<{ change: ViewChange; apply: () => boolean } | null>(null);
  const arrival = useRef<ViewChange["kind"] | null>(null);
  // The leaving content renders once with its exit before the change applies; a chosen tile
  // shows its fill first.
  const present: Presenter = (change, apply) => {
    fold.hold();
    if (change.kind === "settle") commitHaptic();
    setLeaving({ change, apply });
  };
  useEffect(() => {
    if (!leaving) return;
    const { change, apply } = leaving;
    const filling = change.kind === "settle" && change.from.kind !== "button";
    const timer = setTimeout(
      () => {
        arrival.current = change.kind;
        setLeaving(null);
        if (!apply()) release();
      },
      filling ? motion.fill : 0,
    );
    return () => clearTimeout(timer);
  }, [leaving, release]);

  const { view, act } = useAskCard({
    block,
    form,
    messageId,
    waiting: canAnswer,
    onAnswer,
    present,
  });
  useEffect(() => interruptWhenAway(AppState, act.interrupt), [act]);

  const step = view.kind === "open" ? view.step : null;
  return (
    <Animated.View pointerEvents="box-none" style={[styles.fold, fold.style]}>
      <Animated.View
        key={view.kind === "settled" ? "settled" : (step?.question.id ?? "recap")}
        onLayout={fold.onLayout}
        entering={arrival.current ? ARRIVALS[arrival.current] : undefined}
        exiting={leaving && leaving.change.kind !== "advance" ? EXIT : undefined}
      >
        {view.kind === "settled" ? (
          <AskSettled view={view.settled} lineProps={questionProps} />
        ) : (
          openCard()
        )}
      </Animated.View>
    </Animated.View>
  );

  function openCard() {
    if (view.kind !== "open") return null;
    const { lines, busy, filled } = view;
    const muted = { color: tokens.mutedForeground };
    const alert = view.error ? (
      <Text accessibilityRole="alert" style={[styles.meta, { color: tokens.destructive }]}>
        {view.error}
      </Text>
    ) : null;
    const left = step?.left ?? null;
    const mark =
      left === null
        ? null
        : left > 0
          ? t("{count} more", { count: left })
          : step?.reopened
            ? null
            : t("Last one");
    const header = step?.question.header;
    const head =
      left !== null && (header || mark) ? (
        <View style={[styles.head, lines.length > 0 && styles.headAfterLines]}>
          {header ? (
            <Text numberOfLines={1} style={[styles.headText, styles.headName]}>
              {header}
            </Text>
          ) : null}
          {mark ? (
            <Text style={[styles.headText, muted]}>{header ? `· ${mark}` : mark}</Text>
          ) : null}
        </View>
      ) : null;
    const lead =
      lines.length || head || (!step && alert) ? (
        <View>
          {lines.map((line) => (
            <Pressable
              key={line.questionId}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => act.reopen(line.questionId)}
              style={({ pressed }) => [styles.line, pressed && { backgroundColor: tokens.pressed }]}
            >
              <Text numberOfLines={1} style={[styles.lineText, styles.lineLabel, muted]}>
                {line.label}
              </Text>
              <Text numberOfLines={1} style={[styles.lineText, styles.lineValue]}>
                {line.value.kind === "skipped" ? t("Skipped") : line.value.text}
              </Text>
              <NativeSymbol
                ios="chevron.right"
                android="chevron-forward"
                size={12}
                color={tokens.mutedForeground}
              />
            </Pressable>
          ))}
          {head}
          {step ? null : alert}
        </View>
      ) : undefined;
    const actions =
      step?.skip || view.primary ? (
        <>
          {step?.skip ? (
            <CapsuleButton
              kind="tertiary"
              height={TERTIARY_CAPSULE_HEIGHT}
              label={t("Skip")}
              disabled={busy}
              onPress={act.skip}
            />
          ) : null}
          {view.primary ? (
            <CapsuleButton
              kind="primary"
              height={sizes.mobileStack}
              label={view.primary === "next" ? t("Next") : t("Send")}
              disabled={busy}
              onPress={act.confirm}
            />
          ) : null}
        </>
      ) : undefined;
    if (!step) return <FramedBlock lead={lead} actions={actions} />;
    const { question, selected, field } = step;
    const choices = question.options.length > 0;
    return (
      <FramedBlock
        lead={lead}
        question={<Text {...questionProps}>{question.text}</Text>}
        consequence={block.detail}
        actions={actions}
      >
        <View style={[styles.tiles, !actions && styles.tilesFoot]}>
          {question.options.map((option) => {
            const chosen = selected.includes(option.id);
            return (
              <Tile
                key={option.id}
                label={option.label}
                selected={chosen}
                filled={filled?.kind === "option" && filled.optionId === option.id}
                multi={question.multiSelect}
                disabled={busy}
                onPress={() => {
                  if (question.multiSelect || !chosen) selectionHaptic();
                  act.tap(option.id);
                }}
                trailing={chosen ? "checkmark" : null}
              />
            );
          })}
          {field ? (
            <AnswerField
              text={field.text}
              canSend={field.canSend}
              filled={filled?.kind === "field"}
              disabled={busy}
              stacked={left !== null}
              choices={choices}
              onChange={act.typeOther}
              onSend={act.confirm}
            />
          ) : (
            <Tile
              label={t("Other…")}
              muted
              disabled={busy}
              onPress={act.openOther}
              trailing="pencil"
            />
          )}
          {alert}
        </View>
      </FramedBlock>
    );
  }
}

function Tile({
  label,
  selected = false,
  filled = false,
  multi = false,
  muted = false,
  disabled,
  trailing,
  onPress,
}: {
  label: string;
  selected?: boolean;
  filled?: boolean;
  multi?: boolean;
  muted?: boolean;
  disabled: boolean;
  trailing: "checkmark" | "pencil" | null;
  onPress: () => void;
}) {
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const ink = filled ? tokens.chatUserForeground : tokens.foreground;
  return (
    <Pressable
      accessibilityRole={multi ? "checkbox" : "button"}
      accessibilityState={multi ? { checked: selected, disabled } : { selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tile,
        filled
          ? { backgroundColor: tokens.chatUser }
          : {
              backgroundColor: pressed ? tokens.pressed : "transparent",
              boxShadow: selected
                ? `0 0 0 ${sizes.selectedRing}px ${tokens.foreground}`
                : `0 0 0 1px ${pressed ? tokens.optionRingHover : tokens.optionRing}`,
              transform: [{ scale: pressed ? 0.985 : 1 }],
            },
      ]}
    >
      <Text style={[styles.tileLabel, { color: muted ? tokens.mutedForeground : ink }]}>
        {label}
      </Text>
      {trailing ? (
        <NativeSymbol
          ios={trailing}
          android={trailing === "pencil" ? "pencil" : "checkmark"}
          size={15}
          color={muted ? tokens.mutedForeground : ink}
        />
      ) : null}
    </Pressable>
  );
}

function AnswerField({
  text,
  canSend,
  filled,
  disabled,
  stacked,
  choices,
  onChange,
  onSend,
}: {
  text: string;
  canSend: boolean;
  filled: boolean;
  disabled: boolean;
  /** A step of a stack: the button confirms this answer, it sends nothing yet. */
  stacked: boolean;
  /** Opened from "Other…" among options, rather than a question with no options. */
  choices: boolean;
  onChange: (text: string) => void;
  onSend: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const [focused, setFocused] = useState(false);
  const ring = focused
    ? `0 0 0 ${sizes.selectedRing}px ${tokens.foreground}`
    : `0 0 0 1px ${tokens.optionRingHover}`;
  return (
    <View
      style={[
        styles.tile,
        styles.field,
        filled ? { backgroundColor: tokens.chatUser } : { boxShadow: ring },
      ]}
    >
      <TextInput
        accessibilityLabel={choices ? t("Other answer") : t("Answer")}
        value={text}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus={choices}
        editable={!disabled}
        maxLength={ASK_ANSWER_MAX_LENGTH}
        placeholder={choices ? t("Other…") : t("Type your answer")}
        placeholderTextColor={tokens.mutedForeground}
        returnKeyType={stacked ? "next" : "send"}
        submitBehavior="submit"
        onSubmitEditing={onSend}
        style={[
          styles.tileLabel,
          styles.input,
          { color: filled ? tokens.chatUserForeground : tokens.foreground },
        ]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={stacked ? t("Next") : t("Send")}
        disabled={!canSend || disabled}
        onPress={onSend}
        hitSlop={6}
        style={[styles.send, { opacity: canSend ? 1 : 0.3 }]}
      >
        <NativeSymbol
          ios={stacked ? "checkmark" : "arrow.up"}
          android={stacked ? "checkmark" : "arrow-up"}
          size={14}
          weight="semibold"
          color={tokens.primaryForeground}
        />
      </Pressable>
    </View>
  );
}

/** A question card once answered or no longer waiting: one muted line, then the answer. */
export function AskSettled({ view, lineProps }: { view: AskSettledView; lineProps?: TextProps }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const lines = answerLines(view, t);
  const muted = [styles.settledText, { color: tokens.mutedForeground }];
  return (
    <View style={styles.settled}>
      <View style={styles.settledLine}>
        <NativeSymbol
          ios={view.kind === "answered" ? "checkmark" : "stop.circle"}
          android={view.kind === "answered" ? "checkmark" : "stop-circle-outline"}
          size={13}
          color={tokens.mutedForeground}
        />
        <Text {...lineProps} numberOfLines={1} style={[muted, styles.shrink]}>
          {view.line}
        </Text>
        {view.kind === "inactive" ? <Text style={muted}>· {t("No longer active")}</Text> : null}
      </View>
      {lines.length ? (
        <UserBubble
          selectable
          accessibilityLabel={t("Your answer: {answer}", { answer: lines.join("; ") })}
        >
          {lines.join("\n")}
        </UserBubble>
      ) : null}
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    fold: {
      overflow: "hidden",
      justifyContent: "flex-end",
      margin: -BLEED,
      marginTop: -BLEED_TOP,
      padding: BLEED,
      paddingTop: BLEED_TOP,
    },
    meta: nativeTextStyle("meta"),
    head: { flexDirection: "row", gap: 4 },
    headAfterLines: { paddingTop: 10 },
    headText: { color: tokens.foreground, ...nativeTextStyle("question") },
    headName: { flexShrink: 1, fontWeight: "500" },
    line: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 44,
      marginHorizontal: -8,
      paddingHorizontal: 8,
      paddingVertical: 10,
      borderRadius: radii.row,
    },
    lineText: nativeTextStyle("question", { leading: 1.3 }),
    lineLabel: { flexShrink: 0, maxWidth: "50%" },
    lineValue: { flex: 1, color: tokens.foreground },
    tiles: { gap: 8 },
    tilesFoot: { paddingBottom: 14 },
    tile: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderRadius: radii.card,
    },
    tileLabel: { flex: 1, ...nativeTextStyle("question", { weight: 500, leading: 1.3 }) },
    field: { paddingVertical: 8, paddingEnd: 8 },
    input: { fontWeight: "400", paddingVertical: 4 },
    send: {
      width: 32,
      height: 32,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.primary,
    },
    settled: { gap: 14 },
    settledLine: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14 },
    settledText: nativeTextStyle("meta", { size: 14 }),
    shrink: { flexShrink: 1 },
  });
}
