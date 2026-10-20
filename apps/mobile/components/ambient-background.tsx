import { ambient } from "@rakazo/ui-tokens";
import { StyleSheet, View } from "react-native";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { hexWithAlpha } from "../lib/stop-contour-math";

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

/**
 * The page tone fading out under the transparent bar: dense under the title, so it stays legible
 * over any bubble, then a long soft edge rather than a line. The native scroll-edge effect does not reach the thread's inverted list.
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
        experimental_backgroundImage: `linear-gradient(to bottom, ${hexWithAlpha(tokens.background, 0.96)} 0%, ${hexWithAlpha(tokens.background, 0.9)} 65%, ${hexWithAlpha(tokens.background, 0)} 100%)`,
      }}
    />
  );
}
