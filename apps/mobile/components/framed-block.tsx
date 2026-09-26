import { radii } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { shadowsForAppearance } from "../lib/theme";
import { nativeTextStyle } from "../lib/typography";

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
  return (
    <View
      accessibilityState={answered ? { busy: false } : undefined}
      style={[styles.root, style]}
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
        <View style={styles.answered}>
          {typeof answered === "string" ? (
            <Text style={styles.answeredText}>{answered}</Text>
          ) : (
            answered
          )}
        </View>
      ) : (
        <>
          {children ? <View style={styles.body}>{children}</View> : null}
          {actions ? <View style={styles.actions}>{actions}</View> : null}
        </>
      )}
    </View>
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
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 13,
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
      paddingHorizontal: 16,
      paddingTop: 8,
      color: tokens.foreground,
      ...nativeTextStyle("question"),
    },
    // Matches the header's own paddingTop: with no header, the question opens
    // the card at the same spot the header would have.
    questionNoHeader: {
      paddingTop: 13,
    },
    consequence: {
      paddingHorizontal: 16,
      paddingTop: 6,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
    answered: {
      padding: 16,
      paddingTop: 14,
    },
    answeredText: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
    body: {
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    actions: {
      flexDirection: "column",
      gap: 8,
      padding: 16,
      paddingTop: 14,
    },
  });
}
