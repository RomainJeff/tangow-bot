import { ASK_ANSWER_MAX_LENGTH } from "@rakazo/contracts";
import { radii, sizes } from "@rakazo/ui-tokens";
import type { Ref } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

/** Room around the card inside its clip for its ring and drop shadow; above, only the ring. */
export const BLEED = 28;
export const BLEED_TOP = 4;

export function Tile({
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

export function AnswerField({
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

export function createStyles() {
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
    settledLine: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
    settledText: nativeTextStyle("meta", { size: 14 }),
    shrink: { flexShrink: 1 },
  });
}
