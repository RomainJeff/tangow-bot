import { radii, sizes } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { Fragment, useState } from "react";
import { Alert, Pressable, type PressableProps, Text, View, type ViewProps } from "react-native";
import Animated, { withTiming } from "react-native-reanimated";
import { askActionLabel } from "../lib/ask-action-label";
import { CHAT_MOTION, useChatReducedMotion, usePressScaleStyle } from "../lib/chat-motion";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type AskAction = { id: string; label: string; outcome?: "created" | "cancelled" };

/** No design token covers the tertiary capsule's height — the design contract
 * (§3.7) spells it out directly: 40 pt, against the 44 pt primary/secondary. */
export const TERTIARY_CAPSULE_HEIGHT = 40;
/** Extends a 40 pt tertiary capsule's touch target to the 44 pt minimum. */
const TERTIARY_HIT_SLOP = { top: 2, bottom: 2 };

type CapsuleKind = "primary" | "secondary" | "tertiary";

/**
 * A single framed-block action capsule: ink primary, secondary on
 * `tokens.secondary`, or a text-only tertiary. Stacked full width by the
 * caller — every action in a `FramedBlock` reads as its own reachable row.
 */
export function CapsuleButton({
  label,
  kind,
  height,
  disabled,
  onPress,
  icon,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
  hitSlop,
}: {
  label: string;
  kind: CapsuleKind;
  height: number;
  disabled?: boolean;
  onPress: () => void;
  icon?: ReactNode;
  accessibilityLabel?: string;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
  /** Defaults to 2 pt top/bottom on the tertiary kind, so its 40 pt capsule
   * still reaches the 44 pt touch-target minimum. */
  hitSlop?: PressableProps["hitSlop"];
}) {
  const tokens = useMobileTokens();
  // 7e: the capsule presses in 0.95 — nothing at all under reduced motion
  // (MA-10), not a fade substitute.
  const reducedMotion = useChatReducedMotion();
  const { scale, style: pressScaleStyle } = usePressScaleStyle();
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => {
        if (!reducedMotion) {
          scale.value = withTiming(CHAT_MOTION.capsulePressScale, {
            duration: CHAT_MOTION.capsulePressMs,
          });
        }
      }}
      onPressOut={() => {
        if (!reducedMotion) scale.value = withTiming(1, { duration: CHAT_MOTION.capsulePressMs });
      }}
      hitSlop={hitSlop ?? (kind === "tertiary" ? TERTIARY_HIT_SLOP : undefined)}
      style={[
        {
          alignSelf: "stretch",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          height,
          borderRadius: radii.pill,
          paddingHorizontal: 16,
          backgroundColor:
            kind === "primary"
              ? tokens.primary
              : kind === "secondary"
                ? tokens.secondary
                : "transparent",
          opacity: disabled ? 0.5 : 1,
        },
        pressScaleStyle,
      ]}
    >
      {icon}
      <Text
        style={{
          color:
            kind === "primary"
              ? tokens.primaryForeground
              : kind === "secondary"
                ? tokens.foreground
                : tokens.mutedForeground,
          ...nativeTextStyle("capsule", { weight: kind === "primary" ? 500 : 400 }),
        }}
      >
        {label}
      </Text>
    </AnimatedPressable>
  );
}

/**
 * An approval's actions inside a `FramedBlock`: a stacked primary (with a lock
 * glyph)/secondary/tertiary capsule column. Mirrors `apps/web/src/components/AskCard.tsx`.
 */
export function AskActions({
  actions,
  disabled,
  onAnswer,
  onEdit,
  consequential = true,
  accessibilityActions,
  onAccessibilityAction,
}: {
  actions: AskAction[];
  disabled?: boolean;
  onAnswer: (answer: string) => Promise<void>;
  /** A spawn_bot approval can be edited before it is created: a tertiary capsule after Allow. */
  onEdit?: () => void;
  /** The primary action carries a lock; a routine card does not. */
  consequential?: boolean;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const submitting = pendingAction !== null;

  async function submit(answer: string) {
    if (disabled || submitting) return;
    setPendingAction(answer);
    try {
      await onAnswer(answer);
    } catch (error) {
      Alert.alert(
        t("Could not submit answer"),
        error instanceof Error ? error.message : t("Please try again."),
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      {actions.map((action) => {
        const isAllow = action.id === "allow";
        const isAlways = action.id === "always";
        const kind: CapsuleKind = isAllow ? "primary" : isAlways ? "secondary" : "tertiary";
        return (
          <Fragment key={action.id}>
            <CapsuleButton
              kind={kind}
              height={kind === "tertiary" ? TERTIARY_CAPSULE_HEIGHT : sizes.mobileStack}
              disabled={disabled || submitting}
              onPress={() => void submit(action.id)}
              accessibilityActions={accessibilityActions}
              onAccessibilityAction={onAccessibilityAction}
              icon={
                isAllow && consequential ? (
                  <NativeSymbol
                    ios="lock.fill"
                    android="lock-closed"
                    size={13}
                    color={tokens.primaryForeground}
                  />
                ) : undefined
              }
              label={pendingAction === action.id ? t("Sending…") : askActionLabel(action, t)}
            />
            {isAllow && onEdit ? (
              <CapsuleButton
                kind="tertiary"
                height={TERTIARY_CAPSULE_HEIGHT}
                disabled={disabled || submitting}
                onPress={onEdit}
                label={t("Edit")}
              />
            ) : null}
          </Fragment>
        );
      })}
    </View>
  );
}
