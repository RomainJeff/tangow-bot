import { type MaterialKey, materials } from "@rakazo/ui-tokens";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View } from "react-native";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

/** Glass on navigation and controls only: the `chrome` and `control` materials. */
export type GlassMaterial = Extract<MaterialKey, "chrome" | "control">;

function useReduceTransparency(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((enabled) => {
      if (live) setReduced(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduced,
    );
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/**
 * The material behind a control or a bar, drawn under its content: Liquid Glass on iOS 26 and
 * later, the system chrome blur before that, and the material's opaque fallback under Reduce
 * Transparency and on Android. The container keeps its own layout, edge and shadow; this fills
 * it at the given radius.
 */
export function GlassBackdrop({
  material = "control",
  radius,
}: {
  material?: GlassMaterial;
  radius: number;
}) {
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const reduced = useReduceTransparency();
  const shape = [StyleSheet.absoluteFill, { borderRadius: radius }];
  if (Platform.OS !== "ios" || reduced) {
    return (
      <View
        pointerEvents="none"
        style={[shape, { backgroundColor: tokens[materials[material].fallback] }]}
      />
    );
  }
  if (isLiquidGlassAvailable()) {
    // Tinted with the material's fill, as on web: the thread under a control blurs, it never reads.
    return (
      <GlassView
        pointerEvents="none"
        colorScheme={appearance}
        tintColor={materials[material].fill[appearance]}
        style={shape}
      />
    );
  }
  return (
    <BlurView
      pointerEvents="none"
      intensity={100}
      tint={appearance === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
      style={[shape, { overflow: "hidden" }]}
    />
  );
}
