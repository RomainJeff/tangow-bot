import { ambient } from "@rakazo/ui-tokens";
import { StyleSheet, View } from "react-native";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

/** The grey ambient light behind the thread, so the glass on top has something to blur. */
export function AmbientBackground() {
  const appearance = useResolvedAppearance();
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { experimental_backgroundImage: ambient.narrow[appearance] },
      ]}
    />
  );
}

/** `#RRGGBB` at `alpha`, for a gradient stop. */
function withAlpha(hex: string, alpha: number) {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * The page tone fading out under the transparent bar, as on web at phone width: the title stays
 * legible over any bubble. The native scroll-edge effect does not reach the thread's inverted list.
 */
export function ThreadScrollEdge({ height }: { height: number }) {
  const tokens = useMobileTokens();
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height,
        experimental_backgroundImage: `linear-gradient(to bottom, ${withAlpha(tokens.background, 0.96)} 0%, ${withAlpha(tokens.background, 0.85)} 55%, ${withAlpha(tokens.background, 0)} 100%)`,
      }}
    />
  );
}
