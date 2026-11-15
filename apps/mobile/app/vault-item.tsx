import type { BotSecretDestination } from "@tangow/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { type ComponentProps, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Group, Row } from "../components/bot-page/kit";
import { SpokenError } from "../components/bot-page/spoken-error";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { serverMessage } from "../lib/server-error";
import { nativeTextStyle } from "../lib/typography";

type AuthType = BotSecretDestination["auth"]["type"];

/** "api.example.com" or a full URL, as the HTTPS origin a credential is bound to. */
function siteOrigin(site: string): string {
  const trimmed = site.trim();
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return trimmed;
  }
}

/** Adds a credential, or replaces the value of the one passed in and offers to delete it. */
export default function VaultItem() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createVaultItemStyles);
  const params = useLocalSearchParams<{ item?: string }>();
  const item = params.item ? (JSON.parse(params.item) as BotSecretDestination) : null;
  const [site, setSite] = useState("");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<AuthType>("bearer");
  const [authField, setAuthField] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready =
    Boolean(value) &&
    (item !== null ||
      (Boolean(site.trim() && name) && (authType === "bearer" || Boolean(authField.trim()))));

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace("/vault");
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      close();
    } catch (cause) {
      setError(serverMessage(cause) || t("Could not save"));
      setBusy(false);
    }
  }

  function save() {
    if (!ready || busy) return;
    const auth: BotSecretDestination["auth"] =
      authType === "header"
        ? { type: "header", name: authField.trim() }
        : authType === "basic"
          ? { type: "basic", username: authField.trim() }
          : { type: "bearer" };
    const destination = item ?? { name, origin: siteOrigin(site), auth };
    // Cleared before the request, so the value is never shown again.
    setValue("");
    void run(() => rpc("vault/put", { ...destination, value }));
  }

  function remove() {
    if (!item || busy) return;
    Alert.alert(t("Delete {name}?", { name: item.name }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => void run(() => rpc("vault/remove", { name: item.name })),
      },
    ]);
  }

  const field = (
    label: string,
    text: string,
    onChange: (next: string) => void,
    extra: Partial<ComponentProps<typeof TextInput>> = {},
  ) => (
    <Group label={label}>
      <View style={styles.field}>
        <TextInput
          accessibilityLabel={label}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          value={text}
          onChangeText={onChange}
          placeholderTextColor={tokens.mutedForeground}
          style={styles.input}
          {...extra}
        />
      </View>
    </Group>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: item ? item.name : t("New API key"),
          headerBackVisible: false,
          unstable_headerLeftItems: () => [
            {
              type: "button",
              label: t("Cancel"),
              variant: "plain",
              hidesSharedBackground: true,
              onPress: close,
            },
          ],
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: item ? t("Replace key") : t("Save"),
              variant: "done",
              disabled: busy || !ready,
              onPress: save,
            },
          ],
        }}
      />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {item ? null : (
          <>
            {field(t("Site"), site, setSite, {
              placeholder: "api.example.com",
              keyboardType: "url",
              autoFocus: true,
            })}
            {field(
              t("Name"),
              name,
              // Names are what the bot calls the key by: lowercase letters, digits and "_".
              (next) => setName(next.toLowerCase().replace(/[^a-z0-9_]/g, "_")),
              { placeholder: "example_api" },
            )}
            <Group label={t("Sent as")}>
              {(
                [
                  ["bearer", "Bearer"],
                  ["header", t("Header")],
                  ["basic", "Basic"],
                ] as const
              ).map(([type, label]) => (
                <Row
                  key={type}
                  label={label}
                  checked={authType === type}
                  onPress={() => {
                    setAuthType(type);
                    setAuthField("");
                  }}
                />
              ))}
            </Group>
            {authType === "header"
              ? field(t("Header name"), authField, setAuthField, { placeholder: "X-Api-Key" })
              : authType === "basic"
                ? field(t("Username"), authField, setAuthField)
                : null}
          </>
        )}
        {field(t("Key"), value, setValue, {
          secureTextEntry: true,
          autoComplete: "off",
          autoFocus: item !== null,
        })}
        <SpokenError>{error}</SpokenError>
        {item ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={remove}
            style={({ pressed }) => [styles.delete, pressed && styles.pressed]}
          >
            <Text style={styles.deleteLabel}>{t("Delete")}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </>
  );
}

function createVaultItemStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48, gap: 28 },
    field: { paddingHorizontal: 16, paddingVertical: 14 },
    input: { padding: 0, color: tokens.foreground, ...nativeTextStyle("composer") },
    delete: { alignSelf: "center", paddingVertical: 10, paddingHorizontal: 16 },
    deleteLabel: { color: tokens.destructive, ...nativeTextStyle("body") },
    pressed: { opacity: 0.6 },
  });
}
