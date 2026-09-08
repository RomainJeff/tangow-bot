import { useState } from "react";
import { Alert, Pressable, Text, TextInput, View, type ViewProps } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";

type AskAction = { id: string; label: string };

const KNOWN_ASK_ACTION_LABELS: Record<string, string> = {
  allow: "Allow once",
  always: "Always allow",
  deny: "Deny",
};

export function AskActions({
  actions,
  disabled,
  onAnswer,
  allowFreeText,
  accessibilityActions,
  onAccessibilityAction,
}: {
  actions: AskAction[];
  disabled?: boolean;
  onAnswer: (answer: string) => Promise<void>;
  allowFreeText?: boolean;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
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

  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      {actions.map((action) => {
        const emphasized = action.id === "allow" || action.id === "always";
        return (
          <Pressable
            key={action.id}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
            disabled={disabled || submitting}
            onPress={() => void submit(action.id)}
            style={{
              alignSelf: "stretch",
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 12,
              backgroundColor: emphasized ? tokens.muted : "transparent",
              borderWidth: 1,
              borderColor: tokens.border,
              opacity: disabled || submitting ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: 15,
                fontWeight: emphasized ? "600" : "400",
              }}
            >
              {pendingAction === action.id
                ? t("Sending…")
                : Object.hasOwn(KNOWN_ASK_ACTION_LABELS, action.id)
                  ? t(KNOWN_ASK_ACTION_LABELS[action.id]!)
                  : action.label}
            </Text>
          </Pressable>
        );
      })}
      {allowFreeText ? (
        editing ? (
          <View style={{ gap: 6 }}>
            <TextInput
              value={freeText}
              onChangeText={setFreeText}
              editable={!submitting}
              placeholder={t("Type a different answer")}
              placeholderTextColor={tokens.mutedForeground}
              autoFocus
              multiline
              style={{
                alignSelf: "stretch",
                borderRadius: 12,
                borderWidth: 1,
                borderColor: tokens.border,
                paddingHorizontal: 14,
                paddingVertical: 10,
                color: tokens.foreground,
                fontSize: 15,
                minHeight: 44,
              }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                disabled={submitting || freeText.trim().length === 0}
                onPress={() => void submit(freeText.trim())}
                style={{
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  backgroundColor: tokens.muted,
                  opacity: submitting || freeText.trim().length === 0 ? 0.5 : 1,
                }}
              >
                <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "600" }}>
                  {submitting ? t("Sending…") : t("Send answer")}
                </Text>
              </Pressable>
              <Pressable
                disabled={submitting}
                onPress={() => {
                  setFreeText("");
                  setEditing(false);
                }}
                style={{
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderWidth: 1,
                  borderColor: tokens.border,
                  opacity: submitting ? 0.5 : 1,
                }}
              >
                <Text style={{ color: tokens.foreground, fontSize: 15 }}>{t("Cancel")}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            disabled={disabled || submitting}
            onPress={() => setEditing(true)}
            style={{
              alignSelf: "stretch",
              borderRadius: 12,
              paddingHorizontal: 14,
              paddingVertical: 10,
              opacity: disabled || submitting ? 0.5 : 1,
            }}
          >
            <Text style={{ color: tokens.mutedForeground, fontSize: 15 }}>
              {t("Other answer…")}
            </Text>
          </Pressable>
        )
      ) : null}
    </View>
  );
}
