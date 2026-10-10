/** The grouped rows the skill screens are built from, in the app's monochrome skin. */
import { radii } from "@rakazo/ui-tokens";
import { useFocusEffect } from "expo-router";
import { Children, Fragment, type ReactNode, useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../../lib/native";
import { nativeTextStyle } from "../../lib/typography";
import { NativeSymbol } from "../native-symbol";

/** A labelled group of rows on one surface, hairlines inset from the leading edge. */
export function Group({
  label,
  trailing,
  children,
}: {
  label?: string;
  /** A short action on the label's line, such as "Add". */
  trailing?: ReactNode;
  /** No rows leave the label alone, without an empty surface under it. */
  children: ReactNode;
}) {
  const styles = useThemedStyles(createKitStyles);
  return (
    <View style={styles.group}>
      {label || trailing ? (
        <View style={styles.groupHead}>
          <Text style={styles.groupLabel} accessibilityRole="header" numberOfLines={1}>
            {label}
          </Text>
          {trailing}
        </View>
      ) : null}
      {Children.count(children) > 0 ? (
        <View style={styles.card}>
          <Separated>{children}</Separated>
        </View>
      ) : null}
    </View>
  );
}

/** Rows with a hairline between each, for a list built inside a `Group`. */
export function Separated({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createKitStyles);
  return Children.toArray(children).map((row, index) => (
    <Fragment key={index}>
      {index > 0 ? <View style={styles.hairline} /> : null}
      {row}
    </Fragment>
  ));
}

export function GroupAction({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useThemedStyles(createKitStyles);
  return (
    <Pressable accessibilityRole="button" hitSlop={10} onPress={onPress}>
      <Text style={styles.groupAction}>{label}</Text>
    </Pressable>
  );
}

/**
 * One setting: a label, an optional line under it, then what sits on the
 * trailing edge (a value, a control, a disclosure). Pressable when `onPress`.
 * `meta`, the save status, sits under the label so it never narrows it.
 */
export function Row({
  label,
  subline,
  sublineTone = "muted",
  sublineLines = 1,
  value,
  meta,
  chevron,
  checked,
  control,
  leading,
  disabled,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  subline?: string | null;
  sublineTone?: "muted" | "destructive";
  sublineLines?: number;
  value?: string | null;
  meta?: ReactNode;
  chevron?: boolean;
  /** A row of a single-choice list: the chosen one carries a checkmark. */
  checked?: boolean;
  control?: ReactNode;
  leading?: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const styles = useThemedStyles(createKitStyles);
  const tokens = useMobileTokens();
  const body = (
    <>
      {leading}
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, disabled && styles.dimmed]} numberOfLines={2}>
          {label}
        </Text>
        {subline ? (
          <Text
            style={[styles.subline, sublineTone === "destructive" && styles.sublineDestructive]}
            numberOfLines={sublineLines}
          >
            {subline}
          </Text>
        ) : null}
        {meta}
      </View>
      {value ? (
        <Text style={[styles.value, disabled && styles.dimmed]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {checked ? (
        <NativeSymbol
          ios="checkmark"
          android="checkmark"
          size={15}
          weight="semibold"
          color={tokens.foreground}
        />
      ) : null}
      {chevron ? (
        <NativeSymbol
          ios="chevron.forward"
          android="chevron-forward"
          size={13}
          weight="semibold"
          color={tokens.mutedForeground}
        />
      ) : null}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.row}>
        {body}
        {control}
      </View>
    );
  }
  // The control stays outside the pressable part so it remains its own target.
  return (
    <View style={styles.split}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled, ...(checked === undefined ? {} : { selected: checked }) }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.row, styles.splitMain, pressed && styles.pressed]}
      >
        {body}
      </Pressable>
      {control ? <View style={styles.splitControl}>{control}</View> : null}
    </View>
  );
}

/** Rows that keep the height of what is loading, inside a `Group`; never a bare spinner. */
export function LoadingRows() {
  const styles = useThemedStyles(createKitStyles);
  return (
    <View accessibilityState={{ busy: true }}>
      {[0, 1, 2].map((index) => (
        <Fragment key={index}>
          {index > 0 ? <View style={styles.hairline} /> : null}
          <View style={styles.row}>
            <View style={styles.skeletonDot} />
            <View style={styles.skeletonLine} />
          </View>
        </Fragment>
      ))}
    </View>
  );
}

/** A tab whose read failed: "Could not load · Retry", the other tabs untouched. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const styles = useThemedStyles(createKitStyles);
  const { t } = useI18n();
  return (
    <Pressable accessibilityRole="button" onPress={onRetry} style={styles.quiet}>
      <Text style={styles.quietText}>{t("Could not load · Retry")}</Text>
    </Pressable>
  );
}

type Read<T> = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; value: T };

/** Reads `load` whenever the screen comes back into view; a failed refresh keeps what was shown. */
export function useFocusedRead<T>(load: () => Promise<T>, deps: unknown[]) {
  const [read, setRead] = useState<Read<T>>({ kind: "loading" });
  const reload = useCallback(() => {
    let cancelled = false;
    load().then(
      (value) => {
        if (!cancelled) setRead({ kind: "ready", value });
      },
      () => {
        if (!cancelled)
          setRead((current) => (current.kind === "ready" ? current : { kind: "failed" }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, deps);
  useFocusEffect(reload);
  const retry = () => {
    setRead({ kind: "loading" });
    reload();
  };
  return { read, setRead, retry };
}

export function createKitStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    group: { gap: 8 },
    groupHead: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 12,
      paddingHorizontal: 16,
    },
    groupLabel: {
      flexShrink: 1,
      color: tokens.mutedForeground,
      ...nativeTextStyle("label", { size: 13 }),
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    groupAction: { color: tokens.mutedForeground, ...nativeTextStyle("meta", { size: 14 }) },
    card: {
      backgroundColor: tokens.surface,
      borderRadius: radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      overflow: "hidden",
    },
    hairline: {
      height: StyleSheet.hairlineWidth,
      marginStart: 16,
      backgroundColor: tokens.border,
    },
    row: {
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    split: { flexDirection: "row", alignItems: "stretch" },
    splitMain: { flex: 1 },
    splitControl: { justifyContent: "center", paddingEnd: 16 },
    pressed: { backgroundColor: tokens.accent },
    rowText: { flex: 1, minWidth: 0, gap: 3 },
    rowLabel: { color: tokens.foreground, ...nativeTextStyle("composer") },
    dimmed: { opacity: 0.45 },
    subline: { color: tokens.mutedForeground, ...nativeTextStyle("meta", { size: 14 }) },
    sublineDestructive: { color: tokens.destructive },
    // Capped so the label keeps room for its longest word and never breaks inside it.
    value: {
      flexShrink: 1,
      maxWidth: "45%",
      color: tokens.mutedForeground,
      ...nativeTextStyle("composer"),
    },
    skeletonDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: tokens.muted },
    skeletonLine: { flex: 1, height: 14, borderRadius: radii.chip, backgroundColor: tokens.muted },
    quiet: { paddingVertical: 32, alignItems: "center" },
    quietText: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta", { size: 15 }),
      textAlign: "center",
    },
  });
}
