import { Host, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { Platform, Pressable, Text, View } from "react-native";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

type Option<V extends string> = { value: V; label: string };

/** One value among a few: the system segmented control on iOS, a matching track on Android. */
export function SegmentedPicker<V extends string>({
  label,
  selection,
  options,
  onChange,
}: {
  label: string;
  selection: V;
  options: Array<Option<V>>;
  onChange: (value: V) => void;
}) {
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  if (Platform.OS === "ios") {
    return (
      <Host matchContents={{ vertical: true }} colorScheme={scheme}>
        <Picker
          label={label}
          selection={selection}
          onSelectionChange={(value) => onChange(value as V)}
          modifiers={[pickerStyle("segmented")]}
        >
          {options.map((option) => (
            <SwiftText key={option.value} modifiers={[tag(option.value)]}>
              {option.label}
            </SwiftText>
          ))}
        </Picker>
      </Host>
    );
  }
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{ flexDirection: "row", backgroundColor: tokens.muted, borderRadius: 999, padding: 3 }}
    >
      {options.map((option) => {
        const selected = option.value === selection;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) onChange(option.value);
            }}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: selected ? tokens.surface : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: selected ? "600" : "400",
                color: selected ? tokens.foreground : tokens.mutedForeground,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
