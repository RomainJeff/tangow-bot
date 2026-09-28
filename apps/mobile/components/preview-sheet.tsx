import type { ReactNode } from "react";
import { Modal, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

/**
 * The native page sheet a thread opens to show one thing whole (a table, a
 * long report): a titled header with a close button over a scrolling body.
 */
export function PreviewSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
        <View
          style={{
            height: 54,
            flexDirection: "row",
            alignItems: "center",
            borderBottomWidth: 1,
            borderBottomColor: tokens.border,
            paddingStart: 20,
            paddingEnd: 8,
          }}
        >
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={{
              flex: 1,
              color: tokens.foreground,
              ...nativeTextStyle("rowName", { weight: 600 }),
            }}
          >
            {title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Close preview")}
            hitSlop={8}
            onPress={onClose}
            style={({ pressed }) => ({ padding: 12, opacity: pressed ? 0.6 : 1 })}
          >
            <NativeSymbol ios="xmark" android="close" size={17} color={tokens.mutedForeground} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}>
          {children}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
