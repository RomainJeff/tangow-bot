import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { shadowsForAppearance } from "../lib/theme";
import { ShimmerText } from "./shimmer-text";

/** Centred pill over the screen. It swallows touches so a frozen or unconnected frame is inert. */
export function ScreenLinkOverlay({ view }: { view: "connecting" | "reconnecting" }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const shadows = shadowsForAppearance(useResolvedAppearance());
  const reducedMotion = useReducedMotion();
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        styles.center,
        view === "reconnecting" && { backgroundColor: tokens.overlay },
      ]}
    >
      <View style={[styles.pill, { backgroundColor: tokens.card, boxShadow: shadows.floating }]}>
        {reducedMotion ? null : <ActivityIndicator size="small" color={tokens.mutedForeground} />}
        <ShimmerText style={{ color: tokens.mutedForeground, fontSize: 14 }}>
          {view === "connecting" ? t("Connecting…") : t("Reconnecting")}
        </ShimmerText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", padding: 8 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
});
