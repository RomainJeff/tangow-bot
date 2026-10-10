import { Pressable } from "react-native";
import { NativeSymbol } from "../native-symbol";

/** The header's `⋯`, which opens the screen's native action sheet. */
export function MoreButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={10} onPress={onPress}>
      <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
    </Pressable>
  );
}
