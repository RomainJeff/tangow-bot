import type { AskDraft } from "@rakazo/contracts";
import { appIcon } from "@rakazo/core";
import { radii } from "@rakazo/ui-tokens";
import { useState } from "react";
import { Image, StyleSheet } from "react-native";
import Svg, { Path, SvgUri } from "react-native-svg";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

export const APP_LOGO_SIZE = 16;

/**
 * The app a draft goes through: its catalog logo, else the bundled mark, else a neutral glyph.
 * A logo that fails to load gives way to the next one. Mirrors `apps/web/src/components/AppLogo.tsx`.
 */
export function AppLogo({ app, chat }: { app: AskDraft["app"]; chat: boolean }) {
  const tokens = useMobileTokens();
  const [failed, setFailed] = useState<string | null>(null);
  const icon = appIcon({ ...app, logo: app.logo === failed ? null : app.logo }, chat);
  switch (icon.kind) {
    case "logo":
      return /\.svg(?:[?#]|$)/i.test(icon.uri) ? (
        <SvgUri
          uri={icon.uri}
          width={APP_LOGO_SIZE}
          height={APP_LOGO_SIZE}
          onError={() => setFailed(icon.uri)}
        />
      ) : (
        <Image
          accessibilityElementsHidden
          source={{ uri: icon.uri }}
          resizeMode="contain"
          onError={() => setFailed(icon.uri)}
          style={styles.logo}
        />
      );
    case "mark":
      return (
        <Svg
          accessibilityElementsHidden
          width={APP_LOGO_SIZE}
          height={APP_LOGO_SIZE}
          viewBox={icon.mark.viewBox}
        >
          {icon.mark.shapes.map((shape) => (
            <Path
              key={shape.d}
              d={shape.d}
              fill={shape.fill ?? "none"}
              stroke={shape.stroke}
              strokeWidth={shape.strokeWidth}
              strokeLinejoin="round"
            />
          ))}
        </Svg>
      );
    case "glyph":
      return icon.glyph === "message" ? (
        <NativeSymbol
          ios="bubble.left"
          android="chatbubble-outline"
          size={APP_LOGO_SIZE}
          color={tokens.mutedForeground}
        />
      ) : (
        <NativeSymbol
          ios="envelope"
          android="mail-outline"
          size={APP_LOGO_SIZE}
          color={tokens.mutedForeground}
        />
      );
  }
}

const styles = StyleSheet.create({
  logo: { width: APP_LOGO_SIZE, height: APP_LOGO_SIZE, borderRadius: radii.chip },
});
