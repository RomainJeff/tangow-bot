import { SELECTABLE_BOT_COLORS } from "@tangow/contracts";
import { SHAPES } from "@tangow/core";
import { radii } from "@tangow/ui-tokens";
import { useLocalSearchParams } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAvatarStyle } from "../components/avatar-style";
import { BotAvatar } from "../components/bot-avatar";
import { SaveMeta } from "../components/bot-page/kit";
import { mobileTokens } from "../lib/appearance";
import { type BotPageContext, shownSave, useBotPageContext, useBotSetting } from "../lib/bot-page";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

/** The bot's colour, and its shape when the organic avatar is on; each pick saves at once. */
export default function BotAppearanceScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const page = useBotPageContext(botId);
  return page ? <AppearancePicker page={page} /> : null;
}

function AppearancePicker({ page }: { page: BotPageContext }) {
  const styles = useThemedStyles(createAppearanceStyles);
  const { t } = useI18n();
  const { avatarStyle } = useAvatarStyle();
  const color = useBotSetting(page, "color");
  const shape = useBotSetting(page, "shapeSeed");
  const meta = shownSave([color, shape]);
  return (
    <View style={styles.sheet}>
      {avatarStyle === "organic" ? (
        <View style={styles.shapes}>
          {[null, ...SHAPES.map((_, index) => index)].map((seed) => {
            const selected = shape.value === seed;
            return (
              <Pressable
                key={seed ?? "auto"}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={
                  seed === null ? t("Automatic shape") : t("Shape {number}", { number: seed + 1 })
                }
                onPress={() => {
                  if (!selected) void shape.save(seed);
                }}
                style={[styles.shape, selected && styles.shapeOn]}
              >
                {seed === null ? (
                  <Text style={styles.auto}>{t("Auto")}</Text>
                ) : (
                  <BotAvatar
                    color={color.value}
                    identity={page.bot.id}
                    shapeSeed={seed}
                    size={36}
                    variant="organic"
                    still
                  />
                )}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <View style={styles.colors} accessibilityRole="radiogroup">
        {SELECTABLE_BOT_COLORS.map((swatch, index) => {
          const selected = color.value === swatch;
          return (
            <Pressable
              key={swatch}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={t("Color {number}", { number: index + 1 })}
              onPress={() => {
                if (!selected) void color.save(swatch);
              }}
              style={[styles.swatchRing, selected && styles.swatchRingOn]}
            >
              <View style={[styles.swatch, { backgroundColor: swatch }]} />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.meta}>
        {meta ? <SaveMeta state={meta.state} onRetry={() => void meta.retry()} /> : null}
      </View>
    </View>
  );
}

function createAppearanceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 12, gap: 24 },
    shapes: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
    shape: {
      width: 64,
      height: 64,
      borderRadius: radii.row,
      borderWidth: 1,
      borderColor: "transparent",
      alignItems: "center",
      justifyContent: "center",
    },
    shapeOn: { borderColor: tokens.ring, backgroundColor: tokens.muted },
    auto: { color: tokens.mutedForeground, ...nativeTextStyle("time", { size: 13 }) },
    colors: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
    swatchRing: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: 2,
      borderColor: "transparent",
      alignItems: "center",
      justifyContent: "center",
    },
    swatchRingOn: { borderColor: tokens.foreground },
    swatch: {
      width: 30,
      height: 30,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.outline,
    },
    meta: { minHeight: 18, alignItems: "center" },
  });
}
