import { motion, radii, sizes } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { useEffect } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { selectionHaptic } from "../lib/haptics";
import { t } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import type { MenuAction } from "../lib/native-menu";
import { shadowsForAppearance } from "../lib/theme";
import type { VolumeStore } from "../lib/volume-store";
import { useVolume } from "../lib/volume-store";
import { GlassBackdrop } from "./glass";
import { NativeMenu } from "./native-menu";
import { NativeSymbol } from "./native-symbol";

export type ComposerState = "idle" | "typing" | "dictating" | "speaking";

const BAR_DELAYS_MS = [0, 140, 280, 420];
const DICTATION_OUTLINE = 1.5;

export interface ComposerShellProps extends Omit<ViewProps, "children"> {
  /** A mention chip, or the avatar of the bot that is speaking. */
  leading?: ReactNode;
  /** Pending attachments — a row above the field, inside the capsule . */
  attachments?: ReactNode;
  /** The field itself. */
  children: ReactNode;
  /** Round-icon buttons: send, stop (the mobile attach bubble is detached — see `ComposerAttachBubble`). */
  trailing?: ReactNode;
  state?: ComposerState;
  /** The field has focus: a hairline ring, the web's `focus-within` ring. */
  focused?: boolean;
  /** Dictation mode: a 1.5 pt ink outline replaces the usual
   * focus ring, so the capsule reads as "listening" rather than "focused". */
  dictating?: boolean;
  /**
   * Dictation mode's own row, under the field: × on the left, the waveform
   * in the middle (this component's own four bars), then this content on
   * the right (the ✓ disc, plus Stop when a reply is running). Only drawn
   * while `dictating` is true, mirroring `@rakazo/ui-web`'s
   * `dictationCancel`/`dictationConfirm`.
   */
  dictationCancel?: ReactNode;
  dictationConfirm?: ReactNode;
  /** The engine's current input level (`-2`..`10`, at or below 0 is
   * silent), when it reports one via `volumechange`; `null` (the default)
   * falls back to a looping pulse instead of following the audio level. */
  dictationVolume?: VolumeStore;
}

/**
 * The capsule at the bottom of the thread, on the `control` glass.
 * Mirrors `packages/ui-web/src/composer-shell.tsx`. On mobile the attach
 * bubble sits outside it (`ComposerAttachBubble`, in the row `thread.tsx`
 * builds), sharing the same rest/focus elevation.
 */
export function ComposerShell({
  leading,
  attachments,
  children,
  trailing,
  state = "idle",
  focused = false,
  dictating = false,
  dictationCancel,
  dictationConfirm,
  dictationVolume,
  style,
  ...props
}: ComposerShellProps) {
  const styles = useThemedStyles(createComposerShellStyles);
  return (
    <View
      style={[
        styles.root,
        dictating ? styles.dictating : focused ? styles.focused : undefined,
        style,
      ]}
      {...props}
    >
      {/* Inside dictation's outline, the glass follows the border's inner curve. */}
      <GlassBackdrop radius={dictating ? radii.composer - DICTATION_OUTLINE : radii.composer} />
      {attachments ? <View style={styles.attachmentsRow}>{attachments}</View> : null}
      <View style={[styles.fieldRow, leading ? styles.withLeading : styles.withoutLeading]}>
        {leading}
        <View style={styles.field}>{children}</View>
        {trailing}
      </View>
      {dictating && (dictationCancel || dictationConfirm) ? (
        <View style={styles.dictationRow}>
          {dictationCancel}
          <ComposerDictationWaveform volume={dictationVolume} />
          {dictationConfirm}
        </View>
      ) : null}
    </View>
  );
}

/** The waveform in dictation's bottom row: 4 bars, ink, grouped in the
 * middle of the space between × and ✓ (as on web). Follows the engine's own volume level when the module
 * reports one (`volume` in [-2, 10], anything at or below 0 read as silent);
 * otherwise falls back to the looping pulse — frozen either way under
 * reduced motion. */
function ComposerDictationWaveform({ volume: store }: { volume?: VolumeStore }) {
  const styles = useThemedStyles(createComposerShellStyles);
  const volume = useVolume(store);
  return (
    <View style={styles.waveform}>
      {BAR_DELAYS_MS.map((delayMs, index) => (
        <Pulse key={index} delayMs={delayMs} volume={volume} styles={styles} />
      ))}
    </View>
  );
}

/**
 * The detached "+" bubble: 48×48, full round, the capsule's own glass and rest/focus edge. On iOS
 * it opens a native menu; Android shows its own dialog and, while that is open, the bubble pivots
 * 45° into a "×" over `motion.morph` and its label switches to "Close".
 */
export function ComposerAttachBubble({
  open,
  focused,
  actions,
  onAndroidOpen,
}: {
  open: boolean;
  focused: boolean;
  actions: MenuAction[];
  onAndroidOpen: () => void;
}) {
  const tokens = useMobileTokens();
  const shadows = shadowsForAppearance(useResolvedAppearance());
  const reducedMotion = useReducedMotion();
  const rotation = useSharedValue(open ? 45 : 0);

  useEffect(() => {
    const target = open ? 45 : 0;
    if (reducedMotion) {
      rotation.value = target;
      return;
    }
    rotation.value = withTiming(target, {
      duration: motion.morph,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
    });
  }, [open, reducedMotion, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <NativeMenu
      compact
      actions={actions}
      accessibilityLabel={open ? t("Close") : t("Attach file")}
      onAndroidOpen={() => {
        selectionHaptic();
        onAndroidOpen();
      }}
      style={{
        width: sizes.composerAttach,
        height: sizes.composerAttach,
        borderRadius: radii.pill,
        alignItems: "center",
        justifyContent: "center",
        boxShadow: focused ? shadows.composerFocus : shadows.composerRest,
      }}
    >
      <GlassBackdrop radius={sizes.composerAttach / 2} />
      <Animated.View style={animatedStyle}>
        <NativeSymbol ios="plus" android="add" size={20} color={tokens.foreground} />
      </Animated.View>
    </NativeMenu>
  );
}

/** One bar of the waveform. With a live `volume` (`-2`..`10`, from the
 * engine's `volumechange`) it tracks that level directly; otherwise it loops
 * a pulse, out of phase with its siblings via `delayMs`. Either way it's
 * frozen (no animated transition, though the level can still jump) under
 * reduced motion. */
function Pulse({
  delayMs,
  volume,
  styles,
}: {
  delayMs: number;
  volume: number | null;
  styles: ReturnType<typeof createComposerShellStyles>;
}) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(reducedMotion ? 0.7 : 0.3);

  useEffect(() => {
    cancelAnimation(progress);
    const level = volume == null ? null : Math.max(0, Math.min(1, volume / 10));
    if (reducedMotion) {
      progress.value = level ?? 0.7;
      return;
    }
    if (level != null) {
      progress.value = withTiming(level, { duration: 100 });
      return;
    }
    progress.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 420, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.3, { duration: 420, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(progress);
  }, [delayMs, progress, reducedMotion, volume]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scaleY: 0.4 + progress.value * 0.6 }],
  }));

  return <Animated.View style={[styles.bar, animatedStyle]} />;
}

function createComposerShellStyles() {
  const tokens = mobileTokens();
  const shadows = shadowsForAppearance(resolveMobileAppearance());
  return StyleSheet.create({
    root: {
      minHeight: sizes.composerAttach,
      borderRadius: radii.composer,
      padding: 2,
      justifyContent: "flex-end",
      boxShadow: shadows.composerRest,
    },
    focused: {
      boxShadow: shadows.composerFocus,
    },
    dictating: {
      borderWidth: DICTATION_OUTLINE,
      borderColor: tokens.foreground,
      boxShadow: shadows.composerFocus,
    },
    attachmentsRow: {
      flexDirection: "row",
      gap: 8,
      paddingHorizontal: 10,
      // Air on both sides: a preview or an attachment never touches the text below it.
      paddingTop: 10,
      paddingBottom: 10,
    },
    fieldRow: {
      flexDirection: "row",
      alignItems: "flex-end",
      minHeight: sizes.composerTarget,
    },
    withLeading: { paddingStart: 6 },
    withoutLeading: { paddingStart: 12 },
    field: {
      flex: 1,
      minWidth: 0,
    },
    bar: {
      width: 3,
      height: 14,
      borderRadius: 1.5,
      backgroundColor: tokens.foreground,
    },
    waveform: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 3,
      height: sizes.composerTarget,
    },
    dictationRow: {
      flexDirection: "row",
      alignItems: "center",
    },
  });
}
