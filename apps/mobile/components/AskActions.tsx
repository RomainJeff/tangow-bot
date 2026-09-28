import { radii, sizes } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { useState } from "react";
import {
  Alert,
  Pressable,
  type PressableProps,
  Text,
  TextInput,
  View,
  type ViewProps,
} from "react-native";
import { askActionLabel } from "../lib/ask-action-label";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

type AskAction = { id: string; label: string; outcome?: "created" | "cancelled" };

/** No design token covers the tertiary capsule's height — the design contract
 * (§3.7) spells it out directly: 40 pt, against the 44 pt primary/secondary. */
export const TERTIARY_CAPSULE_HEIGHT = 40;
/** Wrapping quick-reply capsules (more than three options) — §3.7. */
const WRAPPING_QUICK_REPLY_HEIGHT = 34;
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      disabled={disabled}
      onPress={onPress}
      hitSlop={hitSlop ?? (kind === "tertiary" ? TERTIARY_HIT_SLOP : undefined)}
      style={{
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
      }}
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
    </Pressable>
  );
}

/**
 * A question's fixed options as quick-reply capsules: stacked full width at
 * 44 pt when there are three or fewer, wrapping at 34 pt otherwise (design
 * contract §3.7). Shared by a plain ask's options and the multi-question
 * stepper's per-question options. `multiSelect` prefixes a checkbox glyph,
 * mirroring the web `AskCard`.
 */
export function QuickReplyCapsules({
  options,
  selectedIds,
  disabled,
  multiSelect,
  pendingLabel,
  onSelect,
  accessibilityActions,
  onAccessibilityAction,
}: {
  options: AskAction[];
  selectedIds: string[];
  disabled?: boolean;
  multiSelect?: boolean;
  /** Shown on the selected capsule instead of its label while submitting. */
  pendingLabel?: string;
  onSelect: (id: string) => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const tokens = useMobileTokens();
  const stacked = options.length <= 3;
  return (
    <View style={stacked ? { gap: 8 } : { flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {options.map((option) => {
        const selected = selectedIds.includes(option.id);
        return (
          <Pressable
            key={option.id}
            accessibilityRole={multiSelect ? "checkbox" : "button"}
            accessibilityState={multiSelect ? { checked: selected } : { selected }}
            accessibilityLabel={option.label}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            disabled={disabled}
            onPress={() => onSelect(option.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: stacked ? "stretch" : "flex-start",
              height: stacked ? sizes.mobileStack : WRAPPING_QUICK_REPLY_HEIGHT,
              paddingHorizontal: 16,
              borderRadius: radii.pill,
              borderWidth: selected ? 0 : 1,
              borderColor: tokens.outline,
              backgroundColor: selected ? tokens.primary : "transparent",
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {multiSelect ? (
              <Text
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{
                  color: selected ? tokens.primaryForeground : tokens.foreground,
                  ...nativeTextStyle("capsule", { weight: selected ? 500 : 400 }),
                }}
              >
                {selected ? "☑ " : "☐ "}
              </Text>
            ) : null}
            <Text
              style={{
                color: selected ? tokens.primaryForeground : tokens.foreground,
                ...nativeTextStyle("capsule", { weight: selected ? 500 : 400 }),
              }}
            >
              {selected && pendingLabel ? pendingLabel : option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The approval/decision actions inside a `FramedBlock`: a consequential
 * approval reads as a stacked primary (with a lock glyph)/secondary/tertiary
 * capsule column; a plain question with fixed options reads as quick-reply
 * capsules with a free-text fallback. Mirrors `apps/web/src/components/AskCard.tsx`.
 */
export function AskActions({
  actions,
  approval,
  disabled,
  onAnswer,
  allowFreeText,
  accessibilityActions,
  onAccessibilityAction,
}: {
  actions: AskAction[];
  /** Consequential approval (Allow once/Always allow this tool/Deny) vs. a
   * plain question with fixed options. */
  approval: boolean;
  disabled?: boolean;
  onAnswer: (answer: string) => Promise<void>;
  allowFreeText?: boolean;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [freeText, setFreeText] = useState("");
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

  const labelFor = (action: AskAction) => askActionLabel(action, t);

  return (
    <View style={{ gap: 8 }}>
      {approval ? (
        <View style={{ gap: 8 }}>
          {actions.map((action) => {
            const isAllow = action.id === "allow";
            const isAlways = action.id === "always";
            const kind: CapsuleKind = isAllow ? "primary" : isAlways ? "secondary" : "tertiary";
            return (
              <CapsuleButton
                key={action.id}
                kind={kind}
                height={kind === "tertiary" ? TERTIARY_CAPSULE_HEIGHT : sizes.mobileStack}
                disabled={disabled || submitting}
                onPress={() => void submit(action.id)}
                accessibilityActions={accessibilityActions}
                onAccessibilityAction={onAccessibilityAction}
                icon={
                  isAllow ? (
                    <NativeSymbol
                      ios="lock.fill"
                      android="lock-closed"
                      size={13}
                      color={tokens.primaryForeground}
                    />
                  ) : undefined
                }
                label={pendingAction === action.id ? t("Sending…") : labelFor(action)}
              />
            );
          })}
        </View>
      ) : (
        <QuickReplyCapsules
          options={actions.map((action) => ({ id: action.id, label: labelFor(action) }))}
          selectedIds={pendingAction ? [pendingAction] : []}
          disabled={disabled || submitting}
          pendingLabel={t("Sending…")}
          onSelect={(id) => void submit(id)}
          accessibilityActions={accessibilityActions}
          onAccessibilityAction={onAccessibilityAction}
        />
      )}
      {allowFreeText ? (
        editing ? (
          <View style={{ gap: 8 }}>
            <TextInput
              value={freeText}
              onChangeText={setFreeText}
              editable={!submitting}
              placeholder={t("Type a different answer")}
              placeholderTextColor={tokens.mutedForeground}
              autoFocus
              multiline
              style={{
                borderRadius: radii.card,
                borderWidth: 1,
                borderColor: tokens.outline,
                backgroundColor: tokens.surface,
                paddingHorizontal: 14,
                paddingVertical: 10,
                color: tokens.foreground,
                minHeight: 44,
                ...nativeTextStyle("body"),
              }}
            />
            <CapsuleButton
              kind="primary"
              height={sizes.mobileStack}
              label={submitting ? t("Sending…") : t("Send answer")}
              disabled={submitting || freeText.trim().length === 0}
              onPress={() => void submit(freeText.trim())}
            />
            <CapsuleButton
              kind="tertiary"
              height={TERTIARY_CAPSULE_HEIGHT}
              label={t("Cancel")}
              disabled={submitting}
              onPress={() => {
                setFreeText("");
                setEditing(false);
              }}
            />
          </View>
        ) : (
          <CapsuleButton
            kind="tertiary"
            height={TERTIARY_CAPSULE_HEIGHT}
            label={t("Other answer…")}
            disabled={disabled || submitting}
            onPress={() => setEditing(true)}
          />
        )
      ) : null}
    </View>
  );
}
