import { radii } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import type { ViewProps, ViewStyle } from "react-native";
import { StyleSheet, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";

export type SurfaceRadius = "card" | "block";

export interface SurfaceProps extends ViewProps {
  /** `card` (14) for a plain card, `block` (18) to match a framed block. */
  radius?: SurfaceRadius;
  children?: ReactNode;
}

/**
 * The unframed card: one fill, one hairline, never a shadow — elevation
 * belongs to `FramedBlock` and `ComposerShell`. Mirrors
 * `packages/ui-web/src/surface.tsx`.
 */
export function Surface({ radius = "card", style, children, ...props }: SurfaceProps) {
  const styles = useThemedStyles(createSurfaceStyles);
  const shape: ViewStyle = { borderRadius: radius === "block" ? radii.block : radii.card };
  return (
    <View style={[styles.base, shape, style]} {...props}>
      {children}
    </View>
  );
}

function createSurfaceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    base: {
      backgroundColor: tokens.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
    },
  });
}
