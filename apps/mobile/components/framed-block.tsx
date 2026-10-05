import { radii } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { CHAT_MOTION, useChatReducedMotion } from "../lib/chat-motion";
import {
  type FramedBlockPhase,
  framedBlockDidTransitionToAnswered,
} from "../lib/framed-block-transition";
import { successHaptic } from "../lib/haptics";
import { useThemedStyles } from "../lib/native";
import { shadowsForAppearance } from "../lib/theme";
import { nativeTextStyle } from "../lib/typography";
import { AnsweredCheck } from "./answered-check";

export interface FramedBlockHeader {
  /** Who is asking, already translated by the caller. */
  who: ReactNode;
  /** Ink dot in front of the header — the bot needs an answer. */
  dot?: boolean;
}

export interface FramedBlockProps extends Omit<ViewProps, "children"> {
  /** Omitted when the row above already names who is asking (a bot row's
   * author line) — the question then opens the card with no header line. */
  header?: FramedBlockHeader;
  question: ReactNode;
  /** What pressing the primary action will do, one line under the question. */
  consequence?: ReactNode;
  /** Controls between the question and the actions (options, a text field). */
  children?: ReactNode;
  /** Capsules — stacked on mobile, one per line. */
  actions?: ReactNode;
  /**
   * The answer that was given. Once set the block is settled: the controls
   * and the actions are gone and only this line remains.
   */
  answered?: ReactNode;
}

/**
 * The only framed element of the thread: a decision or a question the bot
 * cannot make alone. Mirrors `packages/ui-web/src/framed-block.tsx`.
 *
 * 7e: this is the one place the design-motion spec allows a height animation
 * — never on a list row (the transverse rules forbid that, to keep the
 * inverted `FlatList`'s anchor from jumping), but here, inside a row that is
 * already laid out, the card owns its own settle: the controls collapse, the
 * answered line cross-fades in behind a drawn check, and a success haptic
 * confirms — but only the FIRST time this card flips from open to answered
 * while it is mounted. A card already answered when the thread opens (or
 * when this row first mounts at all) renders that line directly, with no
 * animation and no haptic.
 */
export function FramedBlock({
  header,
  question,
  consequence,
  children,
  actions,
  answered,
  style,
  ...props
}: FramedBlockProps) {
  const styles = useThemedStyles(createFramedBlockStyles);
  const tokens = mobileTokens();
  const reducedMotion = useChatReducedMotion();

  const phase: FramedBlockPhase = answered ? "answered" : "open";
  const phaseRef = useRef<FramedBlockPhase | null>(null);
  const didTransition = framedBlockDidTransitionToAnswered(phaseRef.current, phase);
  phaseRef.current = phase;

  useEffect(() => {
    if (didTransition) successHaptic();
    // `didTransition` only ever reads true once per card (the open→answered
    // edge itself never repeats), so re-running this on its own change is
    // exactly the "at that moment, not at tap" rule (spec 7e).
  }, [didTransition]);

  const collapseMs = reducedMotion ? CHAT_MOTION.reducedFadeMs : CHAT_MOTION.decisionCollapseMs;

  return (
    <Animated.View
      accessibilityState={answered ? { busy: false } : undefined}
      // Only the render that settles the card animates its height; any other
      // size change (a pending label, a new line of text) stays instant.
      layout={didTransition ? LinearTransition.duration(collapseMs) : undefined}
      style={[styles.root, answered ? styles.rootSettled : undefined, style]}
      {...props}
    >
      {header ? (
        <View style={styles.header}>
          {header.dot ? <View accessibilityElementsHidden style={styles.dot} /> : null}
          <Text numberOfLines={1} style={styles.headerText}>
            {header.who}
          </Text>
        </View>
      ) : null}
      <Text style={[styles.question, header ? undefined : styles.questionNoHeader]}>
        {question}
      </Text>
      {consequence ? <Text style={styles.consequence}>{consequence}</Text> : null}
      {answered ? (
        <Animated.View
          entering={
            didTransition
              ? FadeIn.duration(
                  reducedMotion ? CHAT_MOTION.reducedFadeMs : CHAT_MOTION.decisionCheckMs,
                )
              : undefined
          }
          style={[styles.answered, { flexDirection: "row", alignItems: "center", gap: 6 }]}
        >
          <AnsweredCheck color={tokens.foreground} animate={didTransition && !reducedMotion} />
          {typeof answered === "string" ? (
            <Text style={styles.answeredText}>{answered}</Text>
          ) : (
            answered
          )}
        </Animated.View>
      ) : (
        <Animated.View exiting={FadeOut.duration(collapseMs)}>
          {children ? <View style={styles.body}>{children}</View> : null}
          {actions ? <View style={styles.actions}>{actions}</View> : null}
        </Animated.View>
      )}
    </Animated.View>
  );
}

function createFramedBlockStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    // `card` carries its own 1px ring, so no separate hairline border.
    root: {
      overflow: "hidden",
      borderRadius: radii.block,
      backgroundColor: tokens.surface,
      boxShadow: shadowsForAppearance(resolveMobileAppearance()).card,
    },
    // Answered: the drop goes, the hairline stays — the thread keeps one elevation.
    rootSettled: {
      boxShadow: shadowsForAppearance(resolveMobileAppearance()).settled,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 14,
      paddingTop: 12,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: tokens.foreground,
    },
    headerText: {
      flexShrink: 1,
      color: tokens.mutedForeground,
      ...nativeTextStyle("blockHeader"),
    },
    question: {
      paddingHorizontal: 14,
      paddingTop: 8,
      color: tokens.foreground,
      ...nativeTextStyle("question"),
    },
    // Matches the header's own paddingTop: with no header, the question opens
    // the card at the same spot the header would have.
    questionNoHeader: {
      paddingTop: 12,
    },
    consequence: {
      paddingHorizontal: 14,
      paddingTop: 6,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
    answered: {
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    answeredText: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
    body: {
      paddingHorizontal: 14,
      paddingTop: 12,
    },
    actions: {
      flexDirection: "column",
      gap: 8,
      padding: 14,
    },
  });
}
