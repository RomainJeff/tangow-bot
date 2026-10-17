import { useAskCard } from "@rakazo/chat-ui/ask-card";
import { ASK_ANSWER_MAX_LENGTH } from "@rakazo/contracts";
import type { AskCardBlock, AskForm, AskSettledView, Presenter, ViewChange } from "@rakazo/core";
import { motion, radii, sizes, springAt } from "@rakazo/ui-tokens";
import type { Ref } from "react";
import { useEffect, useRef, useState } from "react";
import type { LayoutChangeEvent, TextProps } from "react-native";
import { AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, {
  cancelAnimation,
  FadeIn,
  LayoutAnimationConfig,
  ReduceMotion,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens } from "../lib/appearance";
import { answerLines, interruptWhenAway, optionDetail } from "../lib/ask-card";
import { CHAT_MOTION, useChatReducedMotion } from "../lib/chat-motion";
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
const STEPS = 60;
const CURVE = Array.from({ length: STEPS + 1 }, (_, i) =>
  i === STEPS ? 1 : springAt((motion.flight * i) / STEPS),
);
/** `motion.spring` over `motion.flight`, the curve the web flight runs on, so both end on time. */
const FLIGHT = {
  duration: motion.flight,
  easing: (t: number) => {
    "worklet";
    const at = Math.min(t * STEPS, STEPS - 1e-6);
    const i = Math.floor(at);
    const from = CURVE[i] ?? 1;
    return from + ((CURVE[i + 1] ?? 1) - from) * (at - i);
  },
};
const fade = (ms: number) => FadeIn.duration(ms).reduceMotion(ReduceMotion.Never);

/** A rect in the card's overlay, measured from its foot, which the inverted thread keeps still. */
type Box = { left: number; bottom: number; width: number; height: number; radius: number };

function boxIn(overlay: View, view: View, radius: number, done: (box: Box) => void) {
  overlay.measureInWindow((ox, oy, _width, oh) =>
    view.measureInWindow((left, top, width, height) =>
      done({ left: left - ox, bottom: oy + oh - top - height, width, height, radius }),
    ),
  );
}

/**
 * One movement on one spring. The card's height goes from what it was to its new content's as a
 * layout prop, so the rows above in the inverted thread follow frame by frame. On a commit the
 * answer's solid clone rides the same progress from its tile, or up from the card's foot, into the
 * bubble, which shows on the frame the clone lands.
 */
function useFold() {
  const progress = useSharedValue(1);
  const bound = useSharedValue(false);
  const from = useSharedValue(0);
  const to = useSharedValue(0);
  const start = useSharedValue<Box | null>(null);
  const end = useSharedValue<Box | null>(null);
  const hidden = useSharedValue(false);
  const [flying, setFlying] = useState(false);
  const overlay = useRef<View>(null);
  const source = useRef<View>(null);
  const bubble = useRef<Text>(null);
  const [state] = useState({ measured: 0, waiting: false, flying: false });
  const land = () => {
    state.flying = false;
    setFlying(false);
  };
  const clear = () => {
    "worklet";
    start.value = null;
    end.value = null;
    hidden.value = false;
  };
  const fly = () => {
    progress.value = withTiming(1, FLIGHT, (done) => {
      if (!done) return;
      bound.value = false;
      clear();
      runOnJS(land)();
    });
  };
  const release = () => {
    state.waiting = false;
    bound.value = false;
    clear();
    land();
  };
  const style = useAnimatedStyle(() => {
    const height = from.value + (to.value - from.value) * progress.value;
    return bound.value
      ? { minHeight: height, maxHeight: height }
      : { minHeight: 0, maxHeight: FREE };
  });
  const clone = useAnimatedStyle(() => {
    const target = end.value;
    const origin = start.value ?? (target && { ...target, height: 0 });
    if (!origin) return { display: "none" as const };
    const rest = target ?? origin;
    const at = (a: number, b: number) => a + (b - a) * (target ? progress.value : 0);
    return {
      display: "flex" as const,
      left: at(origin.left, rest.left),
      bottom: at(origin.bottom, rest.bottom),
      width: at(origin.width, rest.width),
      height: at(origin.height, rest.height),
      borderRadius: at(origin.radius, rest.radius),
    };
  });
  /** The clone's text is laid out at the bubble's width from the start, so it never reflows. */
  const cloneText = useAnimatedStyle(() => ({ width: (end.value ?? start.value)?.width ?? 0 }));
  const shown = useAnimatedStyle(() => ({ opacity: hidden.value ? 0 : 1 }));
  return {
    flying,
    overlay,
    source,
    bubble,
    style,
    clone,
    cloneText,
    shown,
    release,
    /**
     * Keeps the card at its height, or where a running fold has it, until the new content lays out.
     * `then` runs once the card is held on screen, so the new content never shows a frame unheld.
     */
    hold(then: () => void) {
      const running = state.waiting || state.flying;
      const { measured } = state;
      state.waiting = true;
      land();
      runOnUI(() => {
        cancelAnimation(progress);
        const height = running ? from.value + (to.value - from.value) * progress.value : measured;
        clear();
        from.value = height;
        to.value = height;
        progress.value = 0;
        bound.value = true;
        // The style follows on the next frame; the content changes only after it held.
        requestAnimationFrame(() => requestAnimationFrame(() => runOnJS(then)()));
      })();
    },
    /** The chosen tile or field leaves as a clone; a button's answer rises from the card's foot. */
    depart(fromSource: boolean, then: () => void) {
      const lift = (box: Box | null) => {
        start.value = box;
        hidden.value = true;
        state.flying = true;
        setFlying(true);
        then();
      };
      if (fromSource && overlay.current && source.current) {
        boxIn(overlay.current, source.current, radii.card, lift);
      } else lift(null);
    },
    onLayout(event: LayoutChangeEvent) {
      state.measured = event.nativeEvent.layout.height + BLEED_TOP + BLEED;
      // A later layout, mid-fold, moves where the fold ends.
      to.value = state.measured;
      if (!state.waiting) return;
      state.waiting = false;
      if (!state.flying || !overlay.current || !bubble.current) return fly();
      boxIn(overlay.current, bubble.current, radii.bubble, (box) => {
        end.value = box;
        fly();
      });
    },
  };
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
  const still = useChatReducedMotion();
  const fold = useFold();
  const arrival = useRef<ViewChange["kind"] | null>(null);
  const filling = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(filling.current), []);
  /** The chosen tile fills, then flies into its bubble; reduced motion swaps after the same fill. */
  const present: Presenter = (change, apply) => {
    if (change.kind === "settle") commitHaptic();
    const swap = () => {
      arrival.current = change.kind;
      if (!apply()) fold.release();
    };
    const source = change.kind === "settle" && change.from.kind !== "button";
    const leave = change.kind !== "settle" || still ? swap : () => fold.depart(source, swap);
    const go = () => {
      if (source) filling.current = setTimeout(leave, motion.fill);
      else leave();
    };
    if (still) go();
    else fold.hold(go);
  };

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
  const entering =
    arrival.current === "reopen"
      ? fade(motion.arrive)
      : arrival.current === "settle" && still
        ? fade(CHAT_MOTION.reducedFadeMs)
        : undefined;
  return (
    <Animated.View pointerEvents="box-none" style={[styles.fold, fold.style]}>
      <Animated.View
        key={view.kind === "settled" ? "settled" : (step?.question.id ?? "recap")}
        onLayout={fold.onLayout}
        entering={entering}
      >
        {/* What leaves goes at once: the framed block's own exit would fade it over the flight. */}
        <LayoutAnimationConfig skipExiting>
          {view.kind === "settled" ? settled(view.settled) : openCard()}
        </LayoutAnimationConfig>
      </Animated.View>
      <View
        ref={fold.overlay}
        collapsable={false}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      >
        {fold.flying && view.kind === "settled" ? (
          <Animated.View style={[styles.clone, fold.clone]}>
            <Animated.View style={[styles.cloneText, fold.cloneText]}>
              <UserBubble style={styles.cloneBubble}>
                {answerLines(view.settled, t).join("\n")}
              </UserBubble>
            </Animated.View>
          </Animated.View>
        ) : null}
      </View>
    </Animated.View>
  );

  /** A question card once answered or no longer waiting: one muted line, then the answer. */
  function settled(settledView: AskSettledView) {
    const lines = answerLines(settledView, t);
    const muted = [styles.settledText, { color: tokens.mutedForeground }];
    const answered = settledView.kind === "answered";
    return (
      <View style={styles.settled}>
        <View style={styles.settledLine}>
          <NativeSymbol
            ios={answered ? "checkmark" : "stop.circle"}
            android={answered ? "checkmark" : "stop-circle-outline"}
            size={13}
            color={tokens.mutedForeground}
          />
          <Text {...questionProps} numberOfLines={1} style={[muted, styles.shrink]}>
            {settledView.line}
          </Text>
          {answered ? null : <Text style={muted}>· {t("No longer active")}</Text>}
        </View>
        {lines.length ? (
          <Animated.View style={fold.shown}>
            <UserBubble
              ref={fold.bubble}
              selectable
              accessibilityLabel={t("Your answer: {answer}", { answer: lines.join("; ") })}
            >
              {lines.join("\n")}
            </UserBubble>
          </Animated.View>
        ) : null}
      </View>
    );
  }

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
    // Not disabled while busy: the card ignores them as it commits, and a dimmed Send would show
    // grey on the frames before it folds.
    const actions =
      step?.skip || view.primary ? (
        <>
          {step?.skip ? (
            <View style={styles.trailing}>
              <CapsuleButton
                kind="tertiary"
                height={TERTIARY_CAPSULE_HEIGHT}
                label={t("Skip")}
                onPress={act.skip}
              />
            </View>
          ) : null}
          {view.primary ? (
            <CapsuleButton
              kind="primary"
              height={sizes.mobileStack}
              label={view.primary === "next" ? t("Next") : t("Send")}
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
            const fill = filled?.kind === "option" && filled.optionId === option.id;
            return (
              <Tile
                key={option.id}
                ref={fill ? fold.source : undefined}
                label={option.label}
                detail={optionDetail(option, t)}
                selected={chosen}
                filled={fill}
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
              ref={filled?.kind === "field" ? fold.source : undefined}
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
  ref,
  label,
  detail,
  selected = false,
  filled = false,
  multi = false,
  muted = false,
  disabled,
  trailing,
  onPress,
}: {
  ref?: Ref<View>;
  label: string;
  detail?: string;
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
      ref={ref}
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
      <View style={styles.tileText}>
        <Text style={[styles.tileLabel, { color: muted ? tokens.mutedForeground : ink }]}>
          {label}
        </Text>
        {detail ? (
          <Text style={[styles.tileDetail, { color: filled ? ink : tokens.mutedForeground }]}>
            {detail}
          </Text>
        ) : null}
      </View>
      {/* The check's width stays reserved, as on web, so choosing never rewraps the label. */}
      <View style={styles.trailingSlot}>
        {trailing ? (
          <NativeSymbol
            ios={trailing}
            android={trailing === "pencil" ? "pencil" : "checkmark"}
            size={15}
            color={muted ? tokens.mutedForeground : ink}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

function AnswerField({
  ref,
  text,
  canSend,
  filled,
  disabled,
  stacked,
  choices,
  onChange,
  onSend,
}: {
  ref?: Ref<View>;
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
      ref={ref}
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
    tileText: { flex: 1 },
    tileLabel: nativeTextStyle("question", { weight: 500, leading: 1.3 }),
    tileDetail: nativeTextStyle("meta"),
    trailingSlot: { width: 15, alignItems: "center" },
    field: { paddingVertical: 8, paddingEnd: 8 },
    input: { flex: 1, fontWeight: "400", paddingVertical: 4 },
    send: {
      width: 32,
      height: 32,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.primary,
    },
    trailing: { flexDirection: "row", justifyContent: "flex-end" },
    clone: { position: "absolute", overflow: "hidden", backgroundColor: tokens.chatUser },
    cloneText: { position: "absolute", top: 0, bottom: 0, left: 0, justifyContent: "center" },
    cloneBubble: { alignSelf: "flex-start", maxWidth: "100%" },
    settled: { gap: 14 },
    settledLine: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14 },
    settledText: nativeTextStyle("meta", { size: 14 }),
    shrink: { flexShrink: 1 },
  });
}
