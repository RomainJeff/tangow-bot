import { radii } from "@rakazo/ui-tokens";
import type { ComponentProps } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

export type MessageSheetAction = {
  name: string;
  text: string;
  icon: Pick<ComponentProps<typeof NativeSymbol>, "ios" | "android">;
  onPress: () => void;
};

/**
 * The long-press drawer for a thread message: quick reactions, then its
 * actions in groups. In "text" mode it shows the message's text on its own so
 * any part of it can be selected, which the rendered bubble does not allow.
 */
export function MessageActionsSheet({
  mode,
  reactions,
  groups,
  text,
  onClose,
}: {
  mode: "actions" | "text";
  reactions: { emoji: string; onPress: () => void }[];
  groups: MessageSheetAction[][];
  text: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: tokens.overlay }}>
        <Pressable
          accessibilityLabel={t("Cancel")}
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          key={mode}
          accessibilityViewIsModal
          // The modal hides the backdrop from VoiceOver; the escape gesture
          // is its way out, as Cancel was on the system action sheet.
          onAccessibilityEscape={onClose}
          entering={SlideInDown.duration(220)}
          style={{
            maxHeight: height - insets.top - 24,
            backgroundColor: tokens.popover,
            borderTopLeftRadius: radii.composer,
            borderTopRightRadius: radii.composer,
            paddingTop: 8,
            paddingHorizontal: 16,
            paddingBottom: insets.bottom + 16,
          }}
        >
          {mode === "text" ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 48 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("Close")}
                  hitSlop={8}
                  onPress={onClose}
                  style={{ padding: 8 }}
                >
                  <NativeSymbol ios="xmark" android="close" size={18} />
                </Pressable>
                <Text style={{ color: tokens.popoverForeground, ...nativeTextStyle("rowName") }}>
                  {t("Message")}
                </Text>
              </View>
              {Platform.OS === "ios" ? (
                // A read-only UITextView keeps range selection; iOS Text only
                // offers select-all.
                <TextInput
                  editable={false}
                  multiline
                  scrollEnabled
                  value={text}
                  style={{
                    flexShrink: 1,
                    color: tokens.popoverForeground,
                    paddingTop: 8,
                    ...nativeTextStyle("body"),
                  }}
                />
              ) : (
                <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingTop: 8 }}>
                  <Text
                    selectable
                    style={{ color: tokens.popoverForeground, ...nativeTextStyle("body") }}
                  >
                    {text}
                  </Text>
                </ScrollView>
              )}
            </>
          ) : (
            <ScrollView bounces={false} contentContainerStyle={{ gap: 12 }}>
              <View
                style={{
                  alignSelf: "center",
                  width: 36,
                  height: 5,
                  borderRadius: radii.pill,
                  backgroundColor: tokens.border,
                  marginBottom: 4,
                }}
              />
              {reactions.length ? (
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  {reactions.map((reaction) => (
                    <Pressable
                      key={reaction.emoji}
                      accessibilityRole="button"
                      accessibilityLabel={reaction.emoji}
                      onPress={() => {
                        onClose();
                        reaction.onPress();
                      }}
                      style={({ pressed }) => ({
                        width: 48,
                        height: 48,
                        borderRadius: radii.pill,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: pressed ? tokens.accent : tokens.secondary,
                      })}
                    >
                      <Text style={{ fontSize: 24 }}>{reaction.emoji}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              {groups
                .filter((group) => group.length)
                .map((group) => (
                  <View
                    key={group[0]!.name}
                    style={{
                      backgroundColor: tokens.secondary,
                      borderRadius: radii.block,
                      overflow: "hidden",
                    }}
                  >
                    {group.map((action, index) => (
                      <Pressable
                        key={action.name}
                        accessibilityRole="button"
                        onPress={() => {
                          onClose();
                          action.onPress();
                        }}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 14,
                          minHeight: 52,
                          paddingHorizontal: 16,
                          backgroundColor: pressed ? tokens.accent : undefined,
                        })}
                      >
                        <NativeSymbol
                          ios={action.icon.ios}
                          android={action.icon.android}
                          size={18}
                          color={tokens.secondaryForeground}
                        />
                        <View
                          style={{
                            flex: 1,
                            alignSelf: "stretch",
                            justifyContent: "center",
                            borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                            borderTopColor: tokens.border,
                          }}
                        >
                          <Text
                            style={{
                              color: tokens.secondaryForeground,
                              ...nativeTextStyle("question"),
                            }}
                          >
                            {action.text}
                          </Text>
                        </View>
                      </Pressable>
                    ))}
                  </View>
                ))}
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}
