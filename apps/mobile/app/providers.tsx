import { OPENAI_COMPATIBLE_BASE_URL_HINT, type ThinkingLevel } from "@rakazo/contracts";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeMenu } from "../components/native-menu";
import { ModelProviderList } from "../components/providers/model-provider-list";
import { createProvidersStyles } from "../components/providers/styles";
import { SubscriptionSignIn } from "../components/providers/subscription-sign-in";
import { useModelProviders } from "../components/providers/use-model-providers";
import { VoiceProviders } from "../components/providers/voice-providers";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { thinkingLevelLabel } from "../lib/thinking-level";

const DEFAULT_THINKING = "default";
const THINKING_LEVEL_OPTIONS: ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Model and voice keys belong to the account: the same keys serve every space. */
export default function Providers() {
  const styles = useThemedStyles(createProvidersStyles);
  const { t } = useI18n();
  const [kind, setKind] = useState<"model" | "voice">("model");
  const {
    acceptsKey,
    apiKey,
    baseUrl,
    busy,
    cancelOAuth,
    catalog,
    chooseProvider,
    connectKey,
    contextWindow,
    credential,
    credentials,
    effectiveBaseUrl,
    error,
    featuredProviders,
    groups,
    isActive,
    isOpenAiCompatible,
    loading,
    maxImagesPerPrompt,
    maxTokens,
    modelId,
    modelsForProvider,
    notice,
    oauth,
    oauthPending,
    openAiCompatibleReady,
    pasteCode,
    pending,
    probeModels,
    probeServerModels,
    probing,
    provider,
    reasoning,
    selected,
    setContextWindow,
    setError,
    setMaxImagesPerPrompt,
    setMaxTokens,
    setModelDefault,
    setModelId,
    setNotice,
    setPasteCode,
    setReasoning,
    setShowAdvanced,
    setShowAllProviders,
    setShowApiKey,
    setShowEndpointHelp,
    setSupportsImages,
    setThinkingLevel,
    showAdvanced,
    showAllProviders,
    showApiKey,
    showEndpointHelp,
    startSubscriptionSignIn,
    submitOAuthCode,
    subscriptionSignIn,
    supportsImages,
    thinkingLevel,
    updateApiKey,
    updateBaseUrl,
    visibleGroups,
  } = useModelProviders();

  if (loading && catalog.length === 0) {
    return (
      <SafeAreaView edges={["bottom"]} style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <ModelProviderList
          groups={visibleGroups}
          credentials={credentials}
          selected={kind === "model" ? provider : null}
          expandable={groups.length > featuredProviders.length}
          expanded={showAllProviders}
          onToggleExpanded={() => setShowAllProviders((value) => !value)}
          onSelect={(next) => {
            setKind("model");
            chooseProvider(next);
          }}
        />

        <VoiceProviders
          active={kind === "voice"}
          disabled={busy}
          onActivate={() => {
            cancelOAuth();
            setKind("voice");
          }}
        />

        {kind === "model" && selected ? (
          <>
            {!isOpenAiCompatible ? <Text style={styles.sectionTitle}>{t("Model")}</Text> : null}
            {isOpenAiCompatible ? (
              <>
                <Text style={styles.sectionTitle}>{t("Server URL")}</Text>
                <TextInput
                  accessibilityLabel={t("OpenAI-compatible server URL")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  onChangeText={updateBaseUrl}
                  placeholder={t("http://127.0.0.1:8000/v1")}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.keyInput}
                  value={baseUrl}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showEndpointHelp }}
                  onPress={() => setShowEndpointHelp((visible) => !visible)}
                >
                  <Text style={styles.helpLabel}>{t("Setup help")}</Text>
                </Pressable>
                {showEndpointHelp ? (
                  <Text style={styles.hint}>{t(OPENAI_COMPATIBLE_BASE_URL_HINT)}</Text>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || probing || !effectiveBaseUrl}
                  onPress={() => void probeServerModels()}
                  style={({ pressed }) => [
                    styles.outlineButton,
                    (busy || probing || !effectiveBaseUrl) && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.outlineLabel}>
                    {probing ? t("Finding…") : t("Find models")}
                  </Text>
                </Pressable>
                <Text style={[styles.sectionTitle, { marginTop: 12 }]}>{t("Model")}</Text>
                {probeModels.length && probeModels.includes(modelId) ? (
                  <View style={styles.card}>
                    {probeModels.map((entry) => (
                      <Pressable
                        key={entry}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: entry === modelId }}
                        disabled={probing}
                        onPress={() => setModelId(entry)}
                        style={({ pressed }) => [
                          styles.modelRow,
                          entry === modelId && styles.selectedRow,
                          probing && styles.disabled,
                          pressed && styles.pressed,
                        ]}
                      >
                        <View style={styles.radio}>
                          {entry === modelId ? <View style={styles.radioDot} /> : null}
                        </View>
                        <Text style={styles.modelLabel}>{entry}</Text>
                      </Pressable>
                    ))}
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ selected: false }}
                      disabled={probing}
                      onPress={() => setModelId("")}
                      style={({ pressed }) => [
                        styles.modelRow,
                        probing && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={styles.radio} />
                      <Text style={styles.modelLabel}>{t("Other model…")}</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    <TextInput
                      accessibilityLabel={t("Model id")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!busy && !probing}
                      onChangeText={setModelId}
                      placeholder={t("exact-model-id")}
                      placeholderTextColor={native.tertiaryLabel}
                      style={styles.keyInput}
                      value={modelId}
                    />
                    {probeModels.length ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setModelId(probeModels[0] ?? "")}
                      >
                        <Text style={styles.helpLabel}>{t("Use a found model")}</Text>
                      </Pressable>
                    ) : null}
                  </>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showAdvanced }}
                  onPress={() => setShowAdvanced((visible) => !visible)}
                >
                  <Text style={styles.helpLabel}>{t("Advanced")}</Text>
                </Pressable>
                {showAdvanced ? (
                  <View style={styles.modelRow}>
                    <Text style={styles.modelLabel}>{t("Supports thinking")}</Text>
                    <Switch
                      accessibilityLabel={t("Supports thinking")}
                      value={reasoning}
                      onValueChange={(value) => {
                        setReasoning(value);
                        if (!value) setThinkingLevel(null);
                      }}
                      disabled={busy}
                    />
                  </View>
                ) : null}
                {showAdvanced && reasoning ? (
                  <NativeMenu
                    title={t("Reasoning effort")}
                    accessibilityLabel={t("Reasoning effort")}
                    disabled={busy}
                    options={[
                      { value: DEFAULT_THINKING, label: t("Default") },
                      ...THINKING_LEVEL_OPTIONS.map((level) => ({
                        value: level,
                        label: thinkingLevelLabel(level),
                      })),
                    ]}
                    selected={thinkingLevel ?? DEFAULT_THINKING}
                    onSelect={(value) =>
                      setThinkingLevel(
                        THINKING_LEVEL_OPTIONS.find((level) => level === value) ?? null,
                      )
                    }
                    style={styles.modelRow}
                  >
                    <Text style={styles.modelLabel}>{t("Reasoning effort")}</Text>
                    <Text style={styles.helpLabel}>
                      {thinkingLevel ? thinkingLevelLabel(thinkingLevel) : t("Default")}
                    </Text>
                  </NativeMenu>
                ) : null}
                {showAdvanced ? (
                  <View style={styles.modelRow}>
                    <Text style={styles.modelLabel}>{t("Context limit")}</Text>
                    <TextInput
                      accessibilityLabel={t("Context limit")}
                      editable={!busy}
                      keyboardType="number-pad"
                      maxLength={7}
                      onChangeText={setContextWindow}
                      style={[styles.keyInput, styles.maxImagesInput]}
                      value={contextWindow}
                    />
                  </View>
                ) : null}
                {showAdvanced ? (
                  <View style={styles.modelRow}>
                    <Text style={styles.modelLabel}>{t("Maximum output tokens")}</Text>
                    <TextInput
                      accessibilityLabel={t("Maximum output tokens")}
                      editable={!busy}
                      keyboardType="number-pad"
                      maxLength={6}
                      onChangeText={setMaxTokens}
                      style={[styles.keyInput, styles.maxImagesInput]}
                      value={maxTokens}
                    />
                  </View>
                ) : null}
                {showAdvanced ? (
                  <View style={styles.modelRow}>
                    <Text style={styles.modelLabel}>{t("Supports images")}</Text>
                    <Switch
                      accessibilityLabel={t("Supports images")}
                      value={supportsImages}
                      onValueChange={setSupportsImages}
                      disabled={busy}
                    />
                  </View>
                ) : null}
                {showAdvanced && supportsImages ? (
                  <View style={styles.modelRow}>
                    <Text style={styles.modelLabel}>{t("Maximum images per request")}</Text>
                    <TextInput
                      accessibilityLabel={t("Maximum images per request")}
                      editable={!busy}
                      keyboardType="number-pad"
                      maxLength={4}
                      onChangeText={setMaxImagesPerPrompt}
                      style={[styles.keyInput, styles.maxImagesInput]}
                      value={maxImagesPerPrompt}
                    />
                  </View>
                ) : null}
              </>
            ) : (
              <View style={styles.card}>
                {modelsForProvider.map((entry) => (
                  <Pressable
                    key={`${entry.provider}:${entry.id}`}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: entry.id === selected.id }}
                    onPress={() => {
                      cancelOAuth();
                      setModelId(entry.id);
                      setError(null);
                      setNotice(null);
                    }}
                    style={({ pressed }) => [
                      styles.modelRow,
                      entry.id === selected.id && styles.selectedRow,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.radio}>
                      {entry.id === selected.id ? <View style={styles.radioDot} /> : null}
                    </View>
                    <Text style={styles.modelLabel}>{entry.label}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {!isOpenAiCompatible && selected.billing ? (
              <Text style={styles.billing}>{selected.billing}</Text>
            ) : null}

            {!isOpenAiCompatible ? (
              <View style={styles.credentialCard}>
                <Text style={styles.eyebrow}>{t("Personal credential")}</Text>
                <Text style={styles.credentialTitle}>
                  {credential
                    ? t("Connected · {label}", { label: credential.label })
                    : t("Not connected")}
                </Text>
                <Text style={styles.secondary}>
                  {credential
                    ? t("Stored securely. Never shown here.")
                    : t("Connect this provider to use it as your personal model.")}
                </Text>
              </View>
            ) : null}

            {subscriptionSignIn ? (
              <SubscriptionSignIn
                oauth={oauth}
                pasteCode={pasteCode}
                setPasteCode={setPasteCode}
                submitOAuthCode={submitOAuthCode}
                startSubscriptionSignIn={startSubscriptionSignIn}
                busy={busy}
                oauthPending={oauthPending}
                oauthLabel={selected.oauthLabel}
              />
            ) : null}

            {acceptsKey ? (
              <View style={styles.keySection}>
                {isOpenAiCompatible ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: showApiKey }}
                      onPress={() => setShowApiKey((visible) => !visible)}
                    >
                      <Text style={styles.helpLabel}>{t("API key")}</Text>
                    </Pressable>
                    {showApiKey ? (
                      <TextInput
                        accessibilityLabel={t("API key")}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="off"
                        editable={!busy}
                        importantForAutofill="no"
                        onChangeText={updateApiKey}
                        placeholder={t("Optional")}
                        placeholderTextColor={native.tertiaryLabel}
                        secureTextEntry
                        style={styles.keyInput}
                        textContentType="none"
                        value={apiKey}
                      />
                    ) : null}
                  </>
                ) : (
                  <>
                    <Text style={styles.sectionTitle}>
                      {credential
                        ? t("Replace API key")
                        : subscriptionSignIn
                          ? t("Or connect an API key")
                          : t("API key")}
                    </Text>
                    <TextInput
                      accessibilityLabel={t("API key")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      editable={!busy}
                      importantForAutofill="no"
                      onChangeText={updateApiKey}
                      placeholder={t("sk-…")}
                      placeholderTextColor={native.tertiaryLabel}
                      secureTextEntry
                      style={styles.keyInput}
                      textContentType="none"
                      value={apiKey}
                    />
                  </>
                )}
                <Pressable
                  accessibilityRole="button"
                  disabled={
                    busy || (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)
                  }
                  onPress={() => void connectKey()}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    (busy ||
                      (isOpenAiCompatible ? !openAiCompatibleReady : apiKey.trim().length < 8)) &&
                      styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.primaryLabel}>
                    {pending === "connect"
                      ? t("Saving…")
                      : isOpenAiCompatible
                        ? t("Save")
                        : credential
                          ? t("Replace API key")
                          : t("Connect API key")}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {selected.auth === "oauth" && !subscriptionSignIn ? (
              <Text style={styles.secondary}>
                {t(
                  "This subscription sign-in is not available in Rakazo yet. Use a deployment credential or choose another provider.",
                )}
              </Text>
            ) : null}

            {/* A compatible server's model lives only in the space preference, so it can be switched here. */}
            {isOpenAiCompatible && credential && !isActive ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy || !modelId.trim()}
                onPress={() => void setModelDefault()}
                style={({ pressed }) => [
                  styles.primaryButton,
                  busy && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryLabel}>
                  {pending === "default" ? t("Switching…") : t("Use this model")}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
