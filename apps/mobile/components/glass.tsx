import { materials } from "@rakazo/ui-tokens";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform, StyleSheet, View } from "react-native";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

// The setting can only be read asynchronously: the last value read seeds every later mount, so
// only the very first one can show glass for a frame before turning opaque.
let lastReduced = false;

/** Whether iOS Reduce Transparency is on: glass and the transparent bar then turn opaque. */
export function useReduceTransparency(): boolean {
  const [reduced, setReduced] = useState(lastReduced);
  useEffect(() => {
    let live = true;
    const update = (enabled: boolean) => {
      lastReduced = enabled;
      if (live) setReduced(enabled);
    };
    void AccessibilityInfo.isReduceTransparencyEnabled().then(update);
    const subscription = AccessibilityInfo.addEventListener("reduceTransparencyChanged", update);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/**
 * The `control` material behind a control, drawn under its content: Liquid Glass on iOS 26 and
 * later, the system chrome blur before that, and the material's opaque fallback under Reduce
 * Transparency and on Android. The container keeps its own layout, edge and shadow; this fills
 * it at the given radius.
 */
export function GlassBackdrop({ radius }: { radius: number }) {
  const material = materials.control;
  const tokens = useMobileTokens();
  const appearance = useResolvedAppearance();
  const reduced = useReduceTransparency();
  const shape = [StyleSheet.absoluteFill, { borderRadius: radius }];
  if (Platform.OS !== "ios" || reduced) {
    return (
      <View pointerEvents="none" style={[shape, { backgroundColor: tokens[material.fallback] }]} />
    );
  }
  if (isLiquidGlassAvailable()) {
    // Tinted with the material's fill, as on web: the thread under a control blurs, it never reads.
    return (
      <GlassView
        pointerEvents="none"
        colorScheme={appearance}
        tintColor={material.fill[appearance]}
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
