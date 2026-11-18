import { AVATAR_CHARACTERS, characterById } from "@tangow/contracts";
import { useLocalSearchParams } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { SaveMeta } from "../components/bot-page/kit";
import { NativeSymbol } from "../components/native-symbol";
import { mobileTokens } from "../lib/appearance";
import { type BotPageContext, shownSave, useBotPageContext, useBotSetting } from "../lib/bot-page";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";

/** One row per body shape, in the web picker's order (`BotHero.tsx`). */
const ROWS = (["ball", "capsule", "block"] as const).map((shape) =>
  AVATAR_CHARACTERS.filter((entry) => entry.shape === shape),
);

/** The catalogue of clay characters; one tap chooses and saves, the sheet stays open. */
export default function BotAppearanceScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const page = useBotPageContext(botId);
  return page ? <CharacterPicker page={page} /> : null;
}

function CharacterPicker({ page }: { page: BotPageContext }) {
  const styles = useThemedStyles(createPickerStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const field = useBotSetting(page, "avatarCharacter");
  const chosen = characterById(field.value).id;
  const meta = shownSave([field]);
  return (
    <View style={styles.sheet} accessibilityLabel={t("Appearance")}>
      {ROWS.map((row) => (
        <View key={row[0]?.shape} style={styles.row}>
          {row.map(({ id, name }) => {
            const selected = id === chosen;
            return (
              <Pressable
                key={id}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityState={{ selected }}
                onPress={() => {
                  if (!selected) void field.save(id);
                }}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <BotAvatar color={page.bot.color} character={id} size={64} />
                {selected ? (
                  <View style={styles.check}>
                    <NativeSymbol
                      ios="checkmark"
                      android="checkmark"
                      size={11}
                      weight="bold"
                      color={tokens.background}
                    />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ))}
      <View style={styles.meta}>
        {meta ? <SaveMeta state={meta.state} onRetry={() => void meta.retry()} /> : null}
      </View>
    </View>
  );
}

function createPickerStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { paddingHorizontal: 20, paddingTop: 32, paddingBottom: 12, gap: 14 },
    row: { flexDirection: "row", justifyContent: "center", gap: 18 },
    pressed: { opacity: 0.6 },
    check: {
      position: "absolute",
      right: 0,
      bottom: 0,
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: tokens.background,
      backgroundColor: tokens.foreground,
      alignItems: "center",
      justifyContent: "center",
    },
    meta: { minHeight: 18, alignItems: "center" },
  });
}
