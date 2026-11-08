import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { speakText } from "../lib/voice";

type VoiceCatalogEntry = {
  id: string;
  name: string;
  description: string;
  transcribe: boolean;
};
type VoiceCredential = {
  id: string;
  provider: string;
  voiceId: string;
};
type VoiceStatus = {
  configured: boolean;
  ready: boolean;
  provider: string | null;
  voiceId: string;
};
type VoiceInfo = { id: string; label: string; description?: string };

/** The space's voice choice; keys are connected once in Providers. */
export default function VoiceSettings() {
  const styles = useThemedStyles(createVoiceStyles);
  const { t } = useI18n();
  const router = useRouter();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"voice" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextProvider?: string) => {
    const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
      rpc<VoiceCatalogEntry[]>("voice/catalog"),
      rpc<VoiceCredential[]>("voice/credentials"),
      rpc<VoiceStatus>("voice/status"),
    ]);
    const selected = nextProvider || nextStatus.provider || nextCredentials[0]?.provider || "";
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
    setStatus(nextStatus);
    setProvider(selected);
    const cred = nextCredentials.find((entry) => entry.provider === selected);
    setVoiceId(cred?.voiceId ?? "");
    if (cred) {
      setVoices(await rpc<VoiceInfo[]>("voice/voices", { provider: selected }));
    } else {
      setVoices([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load()
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : t("Could not load voice settings")),
        )
        .finally(() => setLoading(false));
    }, [load]),
  );

  const connectedCatalog = catalog.filter((entry) =>
    credentials.some((cred) => cred.provider === entry.id),
  );
  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);

  async function chooseVoice(nextVoiceId: string) {
    setVoiceId(nextVoiceId);
    setPending("voice");
    try {
      await rpc("voice/setVoice", { voiceId: nextVoiceId, provider: selected?.id });
      await load(selected?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save that voice"));
    } finally {
      setPending(null);
    }
  }

  async function testVoice() {
    setPending("test");
    setError(null);
    try {
      const ready = await speakText(t("Hi, this is how I'll sound when I read replies out loud."));
      if (!ready) {
        throw new Error(t("Connect a voice provider first."));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not play a sample"));
    } finally {
      setPending(null);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {loading ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!loading && !credentials.length ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push("/providers")}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            <Text style={styles.buttonLabel}>{t("Connect a voice provider")}</Text>
          </Pressable>
        ) : null}
        {connectedCatalog.length > 1
          ? connectedCatalog.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityState={{ selected: provider === entry.id }}
                disabled={pending !== null}
                onPress={() => {
                  setProvider(entry.id);
                  setPending("voice");
                  void load(entry.id)
                    .catch((err: unknown) =>
                      setError(
                        err instanceof Error ? err.message : t("Could not load voice settings"),
                      ),
                    )
                    .finally(() => setPending(null));
                }}
                style={[
                  styles.card,
                  provider === entry.id && styles.cardActive,
                  pending !== null && styles.disabled,
                ]}
              >
                <Text style={styles.cardTitle}>{entry.name}</Text>
                <Text style={styles.cardMeta}>
                  {entry.transcribe ? t("Speak + transcribe") : t("Speak only")}
                </Text>
              </Pressable>
            ))
          : null}
        {selected && credential ? (
          <>
            {voices.length ? (
              <View style={styles.voices}>
                {voices.map((voice) => (
                  <Pressable
                    key={voice.id}
                    disabled={pending !== null}
                    onPress={() => void chooseVoice(voice.id)}
                    style={[styles.voiceRow, pending !== null && styles.disabled]}
                  >
                    <Text style={styles.voiceLabel}>{voice.label}</Text>
                    {voiceId === voice.id ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
            {status?.ready ? (
              <Pressable
                disabled={pending !== null}
                onPress={() => void testVoice()}
                style={styles.secondary}
              >
                <Text style={styles.secondaryLabel}>{t("Hear a sample")}</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createVoiceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 10 },
    error: { color: tokens.destructive, marginBottom: 8 },
    card: {
      borderRadius: 14,
      borderWidth: 1,
      borderColor: tokens.border,
      padding: 14,
      backgroundColor: tokens.card,
    },
    cardActive: { borderColor: tokens.ring, backgroundColor: tokens.muted },
    cardTitle: { color: native.label, fontSize: 16 },
    cardMeta: { color: native.tertiaryLabel, marginTop: 4, fontSize: 12 },
    button: {
      marginTop: 8,
      backgroundColor: tokens.primary,
      borderRadius: 12,
      paddingVertical: 12,
      alignItems: "center",
    },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    buttonLabel: { color: tokens.primaryForeground, fontWeight: "600" },
    voices: { marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: tokens.border },
    voiceRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
    },
    voiceLabel: { color: native.label },
    check: { color: tokens.success },
    secondary: { marginTop: 16, alignItems: "center" },
    secondaryLabel: { color: native.secondaryLabel, fontSize: 15 },
  });
}
