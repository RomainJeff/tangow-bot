import {
  insertMarkdownLink,
  prefixMarkdownLines,
  wrapMarkdownCode,
  wrapMarkdownSelection,
} from "@rakazo/core";
import { useRef } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMobileTokens } from "../lib/native";

export function MarkdownEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const tokens = useMobileTokens();
  const input = useRef<TextInput>(null);
  const selection = useRef({ start: 0, end: 0 });
  function apply(next: { text: string; selectionStart: number; selectionEnd: number }) {
    onChange(next.text);
    requestAnimationFrame(() =>
      input.current?.setNativeProps({
        selection: { start: next.selectionStart, end: next.selectionEnd },
      }),
    );
  }
  const currentSelection = () => ({
    selectionStart: selection.current.start,
    selectionEnd: selection.current.end,
  });
  const controls = [
    {
      label: "H",
      accessibilityLabel: "Heading",
      action: () => apply(prefixMarkdownLines(value, currentSelection(), "# ")),
    },
    {
      label: "B",
      accessibilityLabel: "Bold",
      action: () => apply(wrapMarkdownSelection(value, currentSelection(), "**")),
    },
    {
      label: "I",
      accessibilityLabel: "Italic",
      action: () => apply(wrapMarkdownSelection(value, currentSelection(), "_")),
    },
    {
      label: "•",
      accessibilityLabel: "List",
      action: () => apply(prefixMarkdownLines(value, currentSelection(), "- ")),
    },
    {
      label: "☐",
      accessibilityLabel: "Task list",
      action: () => apply(prefixMarkdownLines(value, currentSelection(), "- [ ] ")),
    },
    {
      label: "↗",
      accessibilityLabel: "Link",
      action: () => apply(insertMarkdownLink(value, currentSelection())),
    },
    {
      label: "‹›",
      accessibilityLabel: "Code",
      action: () => apply(wrapMarkdownCode(value, currentSelection())),
    },
  ];
  return (
    <View
      style={{ borderWidth: 1, borderColor: tokens.input, borderRadius: 14, overflow: "hidden" }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityRole="toolbar"
        accessibilityLabel="Markdown formatting"
        style={{
          borderBottomWidth: 1,
          borderColor: tokens.border,
        }}
        contentContainerStyle={{ flexDirection: "row", padding: 4 }}
      >
        {controls.map(({ label, accessibilityLabel, action }) => (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPress={action}
            style={{ paddingHorizontal: 12, paddingVertical: 8 }}
          >
            <Text style={{ color: tokens.foreground }}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <TextInput
        ref={input}
        multiline
        value={value}
        onChangeText={onChange}
        onSelectionChange={(event) => {
          selection.current = event.nativeEvent.selection;
        }}
        accessibilityLabel="Markdown source"
        textAlignVertical="top"
        style={{ minHeight: 260, padding: 14, color: tokens.foreground, fontFamily: "monospace" }}
      />
    </View>
  );
}
