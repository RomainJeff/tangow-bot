import type { MemoryClassifierSettings } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { rpc } from "../lib/api";
import { radii } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export default function JudgmentConnectionScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const [settings, setSettings] = useState<MemoryClassifierSettings | null>(null);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    rpc<MemoryClassifierSettings>("models/judgmentConnection/get")
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setModel(value.connection?.model ?? value.providers[0]?.defaultModel ?? "");
      })
      .catch(() => {
        if (active) setError(t("Could not load classification settings."));
      });
    return () => {
      active = false;
    };
  }, [t]);
  async function save(disconnect = false) {
    if (pending.current || !settings) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await rpc<MemoryClassifierSettings>(
        `models/judgmentConnection/${disconnect ? "disconnect" : "connect"}`,
        disconnect
          ? {}
          : {
              provider: settings.connection?.provider ?? settings.providers[0]?.id,
              model: model.trim(),
              apiKey: apiKey.trim(),
            },
        { timeoutMs: 45_000 },
      );
      setSettings(value);
      setApiKey("");
      setEditing(false);
    } catch {
      setError(t("Could not connect. Check the API key and model, then retry."));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { padding: 24, gap: 16 },
    label: { color: tokens.foreground },
    input: {
      color: tokens.foreground,
      borderColor: tokens.border,
      borderWidth: 1,
      padding: 12,
      borderRadius: radii.row,
    },
    error: { color: tokens.destructive },
  });
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: t("Judgment connection"), gestureEnabled: !busy }} />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {settings ? (
        <>
          <Text style={styles.label}>{settings.spaceName}</Text>
          <Text style={styles.label}>
            {
              settings.providers.find(
                (item) => item.id === (settings.connection?.provider ?? settings.providers[0]?.id),
              )?.name
            }
          </Text>
          {settings.connection && !editing ? (
            <>
              <Text style={styles.label}>
                {settings.connection.model} · {t("Connected")}
              </Text>
              <Button
                color={tokens.primary}
                title={t("Data sharing")}
                onPress={() => router.push("/ai-data-sharing")}
              />
              {settings.canConfigure ? (
                <View>
                  <Button
                    color={tokens.primary}
                    title={t("Edit")}
                    disabled={busy}
                    onPress={() => setEditing(true)}
                  />
                  <Button
                    color={tokens.primary}
                    title={t("Disconnect")}
                    disabled={busy}
                    onPress={() => void save(true)}
                  />
                </View>
              ) : null}
            </>
          ) : settings.canConfigure ? (
            <>
              <Text style={styles.label}>{t("Model")}</Text>
              <TextInput
                accessibilityLabel={t("Model")}
                style={styles.input}
                value={model}
                onChangeText={setModel}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                maxLength={120}
              />
              <Text style={styles.label}>{t("API key")}</Text>
              <TextInput
                accessibilityLabel={t("API key")}
                style={styles.input}
                value={apiKey}
                onChangeText={setApiKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                maxLength={4096}
              />
              <Button
                color={tokens.primary}
                title={busy ? t("Testing…") : t("Test and connect")}
                disabled={busy || !model.trim() || !apiKey.trim()}
                onPress={() => void save()}
              />
              {editing ? (
                <Button
                  color={tokens.primary}
                  title={t("Cancel")}
                  disabled={busy}
                  onPress={() => {
                    setEditing(false);
                    setApiKey("");
                    setModel(settings.connection?.model ?? "");
                  }}
                />
              ) : null}
            </>
          ) : (
            <Text style={styles.label}>{t("Ask a Space owner to connect a classifier.")}</Text>
          )}
        </>
      ) : (
        <Text style={styles.label}>{t("Loading…")}</Text>
      )}
    </ScrollView>
  );
}
