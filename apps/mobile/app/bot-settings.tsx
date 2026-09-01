import {
  AVATAR_SHAPE_COUNT,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  type ComputerMode,
  normalizeCreateBotProfile,
} from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useAvatarStyle } from "../components/avatar-style";
import { BotAvatar } from "../components/bot-avatar";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { type MobileBot, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

type BotSettingsRecord = MobileBot & {
  description?: string;
  instructions?: string;
};

export default function BotSettingsScreen() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const [bot, setBot] = useState<BotSettingsRecord | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [shapeSeed, setShapeSeed] = useState<number | null>(null);
  const [computerMode, setComputerMode] = useState<ComputerMode>("team");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { avatarStyle } = useAvatarStyle();

  useEffect(() => {
    if (!botId) return;
    void rpc<BotSettingsRecord>("bots/get", { botId })
      .then((next) => {
        setBot(next);
        setName(next.name);
        setTitle(next.title);
        setDescription(next.description ?? "");
        setInstructions(next.instructions ?? "");
        setShapeSeed(next.shapeSeed ?? null);
        setComputerMode(next.computerMode);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("Could not load bot")));
  }, [botId]);

  async function save() {
    if (!botId || !bot || pending) return;
    setPending(true);
    setError(null);
    try {
      const profile = normalizeCreateBotProfile({ name, title, description });
      const input: {
        botId: string;
        name?: string;
        title?: string;
        description?: string;
        instructions?: string;
        shapeSeed?: number | null;
      } = { botId };
      if (shapeSeed !== (bot.shapeSeed ?? null)) input.shapeSeed = shapeSeed;
      if (profile.name !== bot.name) input.name = profile.name;
      if (profile.title !== bot.title) input.title = profile.title;
      // Instructions are their own field now, so a description edit must not overwrite them.
      if (profile.description !== (bot.description ?? "")) {
        input.description = profile.description;
      }
      if (instructions !== (bot.instructions ?? "")) input.instructions = instructions;
      if (computerMode !== bot.computerMode) {
        await rpc("bots/setComputer", { botId, mode: computerMode });
      }
      // Use key presence so clearing title/description to "" still persists.
      if (Object.keys(input).length > 1) {
        await rpc("bots/update", input);
      }
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save bot"));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: t("Chat settings") }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChangeText={setName}
          placeholder={t("Name this bot")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Title")}
        </Text>
        <TextInput
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          onChangeText={setTitle}
          placeholder={t("Describe what this bot does")}
          placeholderTextColor={tokens.mutedForeground}
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
          }}
        />
        <Text style={{ color: tokens.mutedForeground, marginTop: 16, fontSize: 14 }}>
          {t("Description")}
        </Text>
        <TextInput
          value={description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this bot is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{
            marginTop: 8,
            backgroundColor: tokens.muted,
            borderRadius: 11,
            padding: 16,
            color: tokens.foreground,
            minHeight: 120,
            textAlignVertical: "top",
          }}
        />
        <Text style={{ color: "#85858A", marginTop: 16, fontSize: 14 }}>Instructions</Text>
        <TextInput
          value={instructions}
          maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
          onChangeText={setInstructions}
          placeholder="How this bot should behave"
          placeholderTextColor="#6C6C70"
          multiline
          style={{
            marginTop: 8,
            backgroundColor: "#1A1A1D",
            borderRadius: 11,
            padding: 16,
            color: "#ECECEE",
            minHeight: 180,
            textAlignVertical: "top",
          }}
        />
        {avatarStyle === "organic" && bot ? (
          <>
            <Text style={{ color: "#85858A", marginTop: 16, fontSize: 14 }}>Shape</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              {[null, ...Array.from({ length: AVATAR_SHAPE_COUNT }, (_, index) => index)].map(
                (seed) => (
                  <Pressable
                    key={seed ?? "auto"}
                    accessibilityRole="button"
                    accessibilityState={{ selected: shapeSeed === seed }}
                    accessibilityLabel={seed === null ? "Automatic shape" : `Shape ${seed + 1}`}
                    onPress={() => setShapeSeed(seed)}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: shapeSeed === seed ? "#5A5A62" : "#26262A",
                      backgroundColor: shapeSeed === seed ? "#1A1A1D" : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {seed === null ? (
                      <Text style={{ color: "#85858A", fontSize: 12 }}>Auto</Text>
                    ) : (
                      <BotAvatar
                        color={bot.color}
                        identity={bot.id}
                        shapeSeed={seed}
                        size={28}
                        variant="organic"
                      />
                    )}
                  </Pressable>
                ),
              )}
            </View>
          </>
        ) : null}
        <ComputerModePicker value={computerMode} onChange={setComputerMode} />
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void save()}
          disabled={!name.trim() || pending || !bot}
          style={{
            marginTop: 24,
            backgroundColor: tokens.primary,
            borderRadius: 11,
            padding: 16,
            alignItems: "center",
            opacity: !name.trim() || pending || !bot ? 0.4 : 1,
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16 }}>
            {pending ? t("Saving…") : t("Save")}
          </Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
