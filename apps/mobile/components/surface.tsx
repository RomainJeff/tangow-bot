import { radii } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import { StyleSheet, View } from "react-native";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";
import { shadowsForAppearance } from "../lib/theme";

export type SurfaceVariant = "default" | "outlined";

export interface SurfaceProps extends ViewProps {
  /** `outlined` trades the paper's edge for a 1 pt `outline` ring — the
   * thread's only outlined card, for a delegated task's result (subagent). */
  variant?: SurfaceVariant;
  children?: ReactNode;
}

/**
 * The bot's paper: what the bot produces sits on the same plane as its bubble,
 * never lifted — elevation belongs to `FramedBlock` and `ComposerShell`.
 * Mirrors `packages/ui-web/src/surface.tsx`.
 */
export function Surface({ variant = "default", style, children, ...props }: SurfaceProps) {
  const styles = useThemedStyles(createSurfaceStyles);
  return (
    <View style={[styles.base, variant === "outlined" && styles.outlined, style]} {...props}>
      {children}
    </View>
  );
}

function createSurfaceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    base: {
      borderRadius: radii.bubble,
      backgroundColor: tokens.chatBot,
      boxShadow: shadowsForAppearance(resolveMobileAppearance()).bubble,
    },
    outlined: {
      boxShadow: `0 0 0 1px ${tokens.outline}`,
    },
  });
}
