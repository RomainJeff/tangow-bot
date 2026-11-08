import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { createProvidersStyles } from "./styles";

type VoiceCatalogEntry = { id: string; name: string; transcribe: boolean };
type VoiceCredential = { id: string; provider: string };

/** Voice keys: one list of providers, and the key form of the one picked while `active`. */
export function VoiceProviders({
  active,
  disabled,
  onActivate,
}: {
  active: boolean;
  disabled: boolean;
  onActivate: () => void;
}) {
  const styles = useThemedStyles(createProvidersStyles);
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [credentials, setCredentials] = useState<VoiceCredential[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextCatalog, nextCredentials] = await Promise.all([
      rpc<VoiceCatalogEntry[]>("voice/catalog"),
      rpc<VoiceCredential[]>("voice/credentials"),
    ]);
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load().catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t("Could not load voice settings")),
      );
    }, [load]),
  );

  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);

  async function connect() {
    if (!selected || apiKey.trim().length < 8) return;
    setPending("connect");
    setError(null);
    setNotice(null);
    try {
      await rpc("voice/connect", { provider: selected.id, apiKey: apiKey.trim() });
      setApiKey("");
      await load();
      setNotice(t("Connected {name}.", { name: selected.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not connect"));
    } finally {
      setPending(null);
    }
  }

  async function disconnect() {
    if (!credential) return;
    setPending("disconnect");
    setError(null);
    setNotice(null);
    try {
      await rpc("voice/disconnect", { provider: credential.provider });
      setApiKey("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not disconnect"));
    } finally {
      setPending(null);
    }
  }

  if (!catalog.length) return null;

  return (
    <>
      <Text style={styles.sectionTitle}>{t("Voice")}</Text>
      <View style={styles.card}>
        {catalog.map((entry) => {
          const connected = credentials.some((cred) => cred.provider === entry.id);
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active && entry.id === provider }}
              disabled={disabled || pending !== null}
              onPress={() => {
                onActivate();
                setProvider(entry.id);
                setApiKey("");
                setError(null);
                setNotice(null);
              }}
              style={({ pressed }) => [
                styles.providerRow,
                active && entry.id === provider && styles.selectedRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.providerCopy}>
                <Text style={styles.providerName}>{entry.name}</Text>
                <Text style={styles.secondary}>
                  {entry.transcribe ? t("Speak + transcribe") : t("Speak only")}
                </Text>
              </View>
              {connected ? <Text style={styles.connected}>{t("Connected")}</Text> : null}
            </Pressable>
          );
        })}
      </View>

      {active && selected ? (
        <View style={styles.keySection}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          <Text style={styles.sectionTitle}>{selected.name}</Text>
          <TextInput
            accessibilityLabel={t("API key")}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={pending === null}
            importantForAutofill="no"
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={credential ? t("Paste a replacement key") : t("Paste your API key")}
            placeholderTextColor={native.tertiaryLabel}
            secureTextEntry
            style={styles.keyInput}
            textContentType="none"
          />
          <Pressable
            accessibilityRole="button"
            disabled={pending !== null || apiKey.trim().length < 8}
            onPress={() => void connect()}
            style={({ pressed }) => [
              styles.primaryButton,
              (pending !== null || apiKey.trim().length < 8) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryLabel}>
              {pending === "connect" ? t("Saving…") : credential ? t("Replace key") : t("Connect")}
            </Text>
          </Pressable>
          {credential ? (
            <Pressable
              accessibilityRole="button"
              disabled={pending !== null}
              onPress={() => void disconnect()}
              style={({ pressed }) => [
                styles.outlineButton,
                pending !== null && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.outlineLabel}>
                {pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </>
  );
}
