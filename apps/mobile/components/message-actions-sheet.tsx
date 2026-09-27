import { radii } from "@rakazo/ui-tokens";
import type { ComponentProps } from "react";
import { useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
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
 * The long-press sheet for a thread message: quick reactions, then its
 * actions in groups, then Select text. Select text shows the message's text on
 * its own so any part of it can be selected, which the rendered bubble does not
 * allow.
 */
export function MessageActionsSheet({
  initialMode,
  reactions,
  groups,
  text,
  close,
}: {
  initialMode: "actions" | "text";
  reactions: { emoji: string; onPress: () => void }[];
  groups: MessageSheetAction[][];
  text: string;
  close: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { height } = useWindowDimensions();
  const [mode, setMode] = useState(initialMode);

  if (mode === "text") {
    return (
      <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 48 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Close")}
            hitSlop={8}
            onPress={close}
            style={{ padding: 8 }}
          >
            <NativeSymbol ios="xmark" android="close" size={18} />
          </Pressable>
          <Text style={{ color: tokens.popoverForeground, ...nativeTextStyle("rowName") }}>
            {t("Message")}
          </Text>
        </View>
        {Platform.OS === "ios" ? (
          // A read-only UITextView keeps range selection; iOS Text only offers
          // select-all.
          <TextInput
            editable={false}
            multiline
            scrollEnabled
            value={text}
            style={{
              maxHeight: height * 0.75,
              flexShrink: 0,
              color: tokens.popoverForeground,
              paddingTop: 8,
              ...nativeTextStyle("body"),
            }}
          />
        ) : (
          <ScrollView
            style={{ maxHeight: height * 0.75, flexGrow: 0, flexShrink: 0 }}
            contentContainerStyle={{ paddingTop: 8 }}
          >
            <Text
              selectable
              style={{ color: tokens.popoverForeground, ...nativeTextStyle("body") }}
            >
              {text}
            </Text>
          </ScrollView>
        )}
      </View>
    );
  }

  const selectText: MessageSheetAction = {
    name: "select",
    text: t("Select text"),
    icon: { ios: "character.cursor.ibeam", android: "text-outline" },
    onPress: () => setMode("text"),
  };
  // Select text sits with the last group, next to Copy.
  const shownGroups = text
    ? [...groups.slice(0, -1), [...(groups.at(-1) ?? []), selectText]]
    : groups;

  return (
    <View style={{ gap: 12, paddingTop: 29, paddingHorizontal: 16, paddingBottom: 16 }}>
      {reactions.length ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          {reactions.map((reaction) => (
            <Pressable
              key={reaction.emoji}
              accessibilityRole="button"
              accessibilityLabel={reaction.emoji}
              onPress={() => {
                close();
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
      {shownGroups
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
                  if (action !== selectText) close();
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
                    style={{ color: tokens.secondaryForeground, ...nativeTextStyle("question") }}
                  >
                    {action.text}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        ))}
    </View>
  );
}
