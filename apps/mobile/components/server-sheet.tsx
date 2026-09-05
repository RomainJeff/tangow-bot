import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { resolveAccessInput } from "../lib/access";
import { accessFor, cachedAccess } from "../lib/access-store";
import {
  apiBaseWarning,
  defaultApiBase,
  normalizeApiBase,
  probeApiBase,
  resetApiBase,
  saveApiBase,
  usesCustomApiBase,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

/**
 * Picks the server this app talks to, and the Cloudflare Access service token
 * for it. Reached before sign-in and again from account settings.
 */
export function ServerSheet({
  visible,
  current,
  onClose,
  onSaved,
}: {
  visible: boolean;
  current: string;
  onClose: () => void;
  onSaved: (url: string) => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createServerSheetStyles);
  const [draft, setDraft] = useState(current);
  const [accessOn, setAccessOn] = useState(false);
  const [accessId, setAccessId] = useState("");
  const [accessSecret, setAccessSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft(current);
    setAccessOn(Boolean(accessFor(current, defaultApiBase())));
    // The stored secret is never shown; leaving the box empty keeps it.
    setAccessId(cachedAccess()?.origin === current ? (cachedAccess()?.clientId ?? "") : "");
    setAccessSecret("");
    setError(null);
    setPending(false);
  }, [visible, current]);

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;
  const savedSecret = cachedAccess()?.origin === current && Boolean(cachedAccess()?.clientId);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const normalized = normalizeApiBase(draft);
      const entered = normalized.ok
        ? resolveAccessInput(
            { clientId: accessId, clientSecret: accessSecret },
            cachedAccess(),
            normalized.url,
          )
        : null;
      const access = accessOn ? entered : null;
      // With the toggle on, an empty form still probes with the build-time token
      // when the URL is the build-time server, matching what the app will send.
      const fallback =
        accessOn && normalized.ok ? accessFor(normalized.url, defaultApiBase()) : null;
      const probed = await probeApiBase(draft, access ?? fallback);
      if (!probed.ok) {
        setError(probed.error);
        return;
      }
      const saved = await saveApiBase(probed.url, access);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      onSaved(saved.url);
    } finally {
      setPending(false);
    }
  }

  async function restoreDefault() {
    setPending(true);
    setError(null);
    try {
      const saved = await resetApiBase();
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      onSaved(saved.url);
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.sheet}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.header}>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.cancel}>{t("Cancel")}</Text>
            </Pressable>
            <Text style={styles.title}>{t("Server")}</Text>
            <Pressable onPress={() => void save()} disabled={pending} hitSlop={8}>
              <Text style={styles.action}>{pending ? t("Checking…") : t("Save")}</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.explanation}>
              {t(
                "Point this app at your self-hosted Rakazo origin, the same HTTPS URL you open in a browser.",
              )}
            </Text>
            <TextInput
              accessibilityLabel={t("Server URL")}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType="url"
              textContentType="URL"
              returnKeyType="go"
              onSubmitEditing={() => void save()}
              placeholder={defaultApiBase()}
              placeholderTextColor={native.tertiaryLabel}
              value={draft}
              onChangeText={(value) => {
                setDraft(value);
                setError(null);
              }}
              style={styles.input}
            />
            {warning ? <Text style={styles.warning}>{warning}</Text> : null}
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>{t("Cloudflare Access protected")}</Text>
              <Switch
                accessibilityLabel={t("Cloudflare Access protected")}
                value={accessOn}
                onValueChange={(value) => {
                  setAccessOn(value);
                  setError(null);
                }}
              />
            </View>
            {accessOn ? (
              <>
                <Text style={styles.explanation}>
                  {t("Enter the service token this server’s Access policy allows.")}
                </Text>
                <TextInput
                  accessibilityLabel={t("Client ID")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  placeholder={t("Client ID")}
                  placeholderTextColor={native.tertiaryLabel}
                  value={accessId}
                  onChangeText={(value) => {
                    setAccessId(value);
                    setError(null);
                  }}
                  style={styles.input}
                />
                <TextInput
                  accessibilityLabel={t("Client secret")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  secureTextEntry
                  placeholder={savedSecret ? t("Client secret (saved)") : t("Client secret")}
                  placeholderTextColor={native.tertiaryLabel}
                  value={accessSecret}
                  onChangeText={(value) => {
                    setAccessSecret(value);
                    setError(null);
                  }}
                  style={styles.input}
                />
              </>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {usesCustomApiBase(current) || draft.trim() !== current ? (
              <Pressable
                onPress={() => void restoreDefault()}
                disabled={pending}
                style={styles.restore}
              >
                <Text style={styles.restoreLabel}>{t("Use default server")}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function createServerSheetStyles() {
  return StyleSheet.create({
    sheet: {
      flex: 1,
      backgroundColor: native.page,
    },
    safeArea: {
      flex: 1,
      paddingHorizontal: 24,
      paddingTop: 12,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    cancel: {
      color: native.secondaryLabel,
      fontSize: 17,
    },
    title: {
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    action: {
      color: native.label,
      fontSize: 17,
      fontWeight: "600",
    },
    content: {
      paddingBottom: 24,
    },
    explanation: {
      color: native.secondaryLabel,
      marginTop: 28,
      fontSize: 15,
      lineHeight: 22,
    },
    input: {
      marginTop: 20,
      backgroundColor: native.fill,
      borderRadius: 13,
      padding: 16,
      color: native.label,
      fontSize: 16,
    },
    warning: {
      color: native.tertiaryLabel,
      marginTop: 12,
      fontSize: 13,
    },
    toggleRow: {
      marginTop: 28,
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    toggleLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    error: {
      color: "#FF6961",
      marginTop: 12,
    },
    restore: {
      marginTop: 28,
      alignItems: "center",
    },
    restoreLabel: {
      color: native.secondaryLabel,
      fontSize: 15,
    },
  });
}
