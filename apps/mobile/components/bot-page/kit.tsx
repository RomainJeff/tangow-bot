import type { FieldSaveState } from "@rakazo/core";
import { radii, tokensForAppearance } from "@rakazo/ui-tokens";
import { useFocusEffect } from "expo-router";
import {
  Children,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { claimSaveAnnouncement } from "../../lib/save-announce";
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
      <View style={styles.card}>
        <Separated>{children}</Separated>
      </View>
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

export function GroupAction({
  label,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const styles = useThemedStyles(createKitStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={10}
      onPress={onPress}
    >
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
  const body = (meta: ReactNode) => (
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
        {body(meta)}
        {control}
      </View>
    );
  }
  // The control and the meta (a save's Retry) stay outside the pressable part, each its own target.
  return (
    <View>
      <View style={styles.split}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ disabled, ...(checked === undefined ? {} : { selected: checked }) }}
          disabled={disabled}
          onPress={onPress}
          style={({ pressed }) => [styles.row, styles.splitMain, pressed && styles.pressed]}
        >
          {body(null)}
        </Pressable>
        {control ? <View style={styles.splitControl}>{control}</View> : null}
      </View>
      {meta ? (
        <View pointerEvents="box-none" style={styles.metaBelow}>
          {meta}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The app's switch, a native one in the monochrome skin: the system's white thumb, the system's
 * grey track when off, ink when on. Dark ink is near white, so dark turns on to a lighter grey
 * than the system's off track, which the white thumb still reads on.
 */
export function InkSwitch({
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const appearance = useResolvedAppearance();
  const tokens = tokensForAppearance(appearance);
  // Dark mirrors web: an "on" switch is a light track with a dark thumb, since a white thumb
  // on any grey on-track reads the same as "off".
  const darkOn = appearance === "dark" && value;
  return (
    <Switch
      accessibilityLabel={accessibilityLabel}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
      trackColor={{ false: tokens.input, true: tokens.primary }}
      thumbColor={darkOn ? tokens.primaryForeground : undefined}
      ios_backgroundColor={tokens.input}
    />
  );
}

/**
 * "Saving…", "Saved 14:02" for three seconds, or "Could not save · Retry"
 * until a retry succeeds, with the server's reason in place of "Could not save"
 * when it gave one. Nothing at rest.
 */
export function SaveMeta({
  state,
  onRetry,
}: {
  state: FieldSaveState<unknown>;
  onRetry?: () => void;
}) {
  const styles = useThemedStyles(createKitStyles);
  const { t } = useI18n();
  const text =
    state.kind === "saving"
      ? t("Saving…")
      : state.kind === "saved"
        ? t("Saved {time}", {
            time: new Intl.DateTimeFormat(dateLocaleForUi(), {
              hour: "numeric",
              minute: "2-digit",
            }).format(new Date(state.at)),
          })
        : state.kind === "failed"
          ? state.reason
            ? `${state.reason} · ${t("Retry")}`
            : t("Could not save · Retry")
          : "";
  // A live region only speaks on Android; VoiceOver needs the outcome said out loud.
  useEffect(() => {
    if (Platform.OS === "ios" && claimSaveAnnouncement(state)) {
      AccessibilityInfo.announceForAccessibility(text);
    }
  }, [state, text]);
  if (state.kind === "idle") return null;
  if (state.kind !== "failed") {
    return (
      <Text style={styles.meta} accessibilityLiveRegion="polite">
        {text}
      </Text>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLiveRegion="polite"
      disabled={!onRetry}
      hitSlop={8}
      onPress={onRetry}
      style={styles.metaFailedTarget}
    >
      <Text style={[styles.meta, styles.metaFailed]} numberOfLines={3}>
        {text}
      </Text>
    </Pressable>
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

export function QuietLine({ children }: { children: string }) {
  const styles = useThemedStyles(createKitStyles);
  return (
    <View style={styles.quiet}>
      <Text style={styles.quietText}>{children}</Text>
    </View>
  );
}

type Read<T> = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; value: T };

/**
 * Reads `load` whenever the screen comes back into view and whenever `deps` change; only the
 * latest read or write lands, and a failed refresh keeps what was shown.
 */
export function useFocusedRead<T>(load: () => Promise<T>, deps: unknown[]) {
  const [read, setRead] = useState<Read<T>>({ kind: "loading" });
  const latest = useRef(0);
  const reload = useCallback(() => {
    const request = ++latest.current;
    load().then(
      (value) => {
        if (request === latest.current) setRead({ kind: "ready", value });
      },
      () => {
        if (request === latest.current)
          setRead((current) => (current.kind === "ready" ? current : { kind: "failed" }));
      },
    );
    return () => {
      if (request === latest.current) latest.current += 1;
    };
  }, deps);
  useFocusEffect(reload);
  const retry = () => {
    setRead({ kind: "loading" });
    reload();
  };
  /**
   * Call as a write begins; pass its answer to the returned settle. Reads that began before the
   * write no longer land, while one begun since (the screen came back into view) still does.
   */
  const write = () => {
    const begun = latest.current;
    return (next: (current: Read<T>) => Read<T>) => {
      if (latest.current === begun) latest.current += 1;
      setRead(next);
    };
  };
  return { read, write, retry };
}

function createKitStyles() {
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
    // Drawn over the row's bottom padding, so a meta that renders nothing adds no height.
    metaBelow: { marginTop: -12, paddingHorizontal: 16, paddingBottom: 12 },
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
    meta: { color: tokens.mutedForeground, ...nativeTextStyle("time", { size: 13 }) },
    metaFailed: { color: tokens.destructive },
    metaFailedTarget: { alignSelf: "flex-start" },
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
