import type { ModelOAuthBegin } from "@rakazo/contracts";
import { Linking, Pressable, Text, TextInput, View } from "react-native";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { createProvidersStyles } from "./styles";

/** Subscription sign-in: opens the provider's page, then waits for the code or the callback. */
export function SubscriptionSignIn({
  oauth,
  pasteCode,
  setPasteCode,
  submitOAuthCode,
  startSubscriptionSignIn,
  busy,
  oauthPending,
  oauthLabel,
}: {
  oauth: ModelOAuthBegin | null;
  pasteCode: string;
  setPasteCode: (value: string) => void;
  submitOAuthCode: () => Promise<void>;
  startSubscriptionSignIn: () => Promise<void>;
  busy: boolean;
  oauthPending: boolean;
  oauthLabel?: string;
}) {
  const styles = useThemedStyles(createProvidersStyles);
  const { t } = useI18n();
  return oauth ? (
    <View style={styles.oauthCard}>
      {oauth.mode === "auth-url" ? (
        <>
          <Text style={styles.secondary}>{t("Finish signing in in your browser:")}</Text>
          <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
            <Text style={styles.link}>{oauth.verificationUri}</Text>
          </Pressable>
          <Text style={styles.secondary}>
            {t("The final page may not load. Paste its URL or code here.")}
          </Text>
          <TextInput
            accessibilityLabel={t("Authorization code")}
            value={pasteCode}
            onChangeText={setPasteCode}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("http://localhost:53692/callback?code=…")}
            placeholderTextColor={native.secondaryLabel}
            style={styles.keyInput}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!pasteCode.trim()}
            onPress={() => void submitOAuthCode()}
            style={({ pressed }) => [
              styles.outlineButton,
              pressed && styles.pressed,
              !pasteCode.trim() && styles.disabled,
            ]}
          >
            <Text style={styles.outlineLabel}>{t("Submit")}</Text>
          </Pressable>
          <Text style={styles.secondary}>{t("Waiting for sign-in…")}</Text>
        </>
      ) : (
        <>
          <Text style={styles.secondary}>{t("Enter this code in your browser:")}</Text>
          <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
            <Text style={styles.link}>{oauth.verificationUri}</Text>
          </Pressable>
          <Text style={styles.code}>{oauth.userCode}</Text>
          <Text style={styles.secondary}>{t("Waiting for sign-in…")}</Text>
        </>
      )}
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={() => void startSubscriptionSignIn()}
      style={({ pressed }) => [
        styles.outlineButton,
        pressed && styles.pressed,
        busy && styles.disabled,
      ]}
    >
      <Text style={styles.outlineLabel}>
        {oauthPending ? t("Starting…") : (oauthLabel ?? t("Sign in"))}
      </Text>
    </Pressable>
  );
}
