import { sizes } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

export interface MessageRowMeta {
  /** The proof line, already translated ("Sent to #ops", "2 sources"). */
  label: ReactNode;
  onPress?: () => void;
}

export interface MessageRowProps extends Omit<ViewProps, "children"> {
  avatar: ReactNode;
  author: ReactNode;
  time?: ReactNode;
  children: ReactNode;
  meta?: MessageRowMeta;
  /** Anchored beside the row — mobile has no hover, so this is for a caller
   * that wants a persistent trailing element (rare; usually omitted). */
  trailing?: ReactNode;
}

/**
 * A bot message: avatar, name, time, prose. No fill, no border — the thread
 * frames nothing except a decision. Mirrors
 * `packages/ui-web/src/message-row.tsx`; mobile's avatar is 26 (`sizes.message`)
 * with an 11 px gap per design contract §3.7, vs the web gap of 14. A string
 * child gets the `body` token; a node child (markdown, a card) lands in a
 * plain `View` and brings its own typography.
 */
export function MessageRow({
  avatar,
  author,
  time,
  children,
  meta,
  trailing,
  style,
  ...props
}: MessageRowProps) {
  const styles = useThemedStyles(createMessageRowStyles);
  return (
    <View style={[styles.root, style]} {...props}>
      <View style={styles.avatar}>{avatar}</View>
      <View style={styles.content}>
        <View style={styles.head}>
          <Text style={styles.author}>{author}</Text>
          {time ? <Text style={styles.time}>{time}</Text> : null}
        </View>
        {typeof children === "string" || typeof children === "number" ? (
          <Text style={styles.body}>{children}</Text>
        ) : (
          // React Native has no style inheritance through a `View`, so prose
          // arrives as a string and anything richer (markdown, a card, a
          // reasoning disclosure) brings its own typography.
          <View>{children}</View>
        )}
        {meta ? (
          <Pressable
            accessibilityRole={meta.onPress ? "button" : undefined}
            onPress={meta.onPress}
            style={styles.meta}
          >
            <Text style={styles.metaText}>{meta.label}</Text>
            <Text accessibilityElementsHidden style={styles.metaText}>
              {"›"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}

function createMessageRowStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    root: {
      flexDirection: "row",
      gap: 11,
    },
    avatar: {
      width: sizes.message,
      flexShrink: 0,
    },
    content: {
      flex: 1,
      minWidth: 0,
    },
    head: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 7,
      marginBottom: 3,
    },
    author: {
      color: tokens.foreground,
      ...nativeTextStyle("author"),
    },
    time: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("time"),
    },
    body: {
      color: tokens.foreground,
      // Design contract §1.2: mobile message prose is 16/1.5 vs the shared 16.5/1.58.
      ...nativeTextStyle("body", { size: 16, leading: 1.5 }),
    },
    meta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 7,
      alignSelf: "flex-start",
    },
    metaText: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
  });
}
