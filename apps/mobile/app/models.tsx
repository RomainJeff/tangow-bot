import type { ModelCategory, ModelCategoryAssignment, ThinkingLevel } from "@rakazo/contracts";
import { connectedModelOptions, parseModelOptionKey, thinkingChoices } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeMenu } from "../components/native-menu";
import type { MobileMe, MobileModel, MobileModelCredential } from "../lib/api";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import { thinkingLevelLabel } from "../lib/thinking-level";

/** The space's model choice; keys are connected once in Providers. */
export default function Models() {
  const styles = useThemedStyles(createModelsStyles);
  const { t } = useI18n();
  const [routing, setRouting] = useState<{ auto: boolean; categories: ModelCategoryAssignment[] }>({
    auto: false,
    categories: [],
  });
  const [routingBusy, setRoutingBusy] = useState(false);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [me, setMe] = useState<MobileMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [nextMe, nextCatalog, nextCredentials, nextRouting] = await Promise.all([
      rpc<MobileMe>("me"),
      rpc<MobileModel[]>("models/list"),
      rpc<MobileModelCredential[]>("models/credentials"),
      rpc<{ auto: boolean; categories: ModelCategoryAssignment[] }>("models/routing"),
    ]);
    setMe(nextMe);
    setRouting(nextRouting);
    setCatalog(nextCatalog);
    setCredentials(nextCredentials);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load()
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : t("Could not load model settings")),
        )
        .finally(() => setLoading(false));
    }, [load]),
  );

  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );

  const connectedOptions = connectedModelOptions(credentials, catalog);
  const categoryLabels: Array<{ category: ModelCategory; label: string }> = [
    { category: "fast", label: t("Fast") },
    { category: "everyday", label: t("Everyday") },
    { category: "complex", label: t("Complex") },
  ];
  async function saveRouting(action: () => Promise<unknown>) {
    setRoutingBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("Could not change the default model"));
    } finally {
      setRoutingBusy(false);
    }
  }
  function assignCategory(
    category: ModelCategory,
    key: string,
    thinkingLevel: ThinkingLevel | null = null,
  ) {
    const model = parseModelOptionKey(key);
    return saveRouting(() =>
      model
        ? rpc("models/setCategory", { category, ...model, thinkingLevel })
        : rpc("models/clearCategory", { category }),
    );
  }

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
        <View style={styles.card}>
          <NativeMenu
            title={t("Active model")}
            accessibilityLabel={t("Active model")}
            disabled={routingBusy}
            selected={routing.auto ? "auto" : `${me?.defaultProvider}::${me?.defaultModel}`}
            options={[
              { value: "auto", label: t("Auto") },
              ...connectedOptions.map((option) => ({ value: option.key, label: option.label })),
            ]}
            onSelect={(key) =>
              void saveRouting(async () => {
                if (key === "auto") {
                  await rpc("models/setAuto", { enabled: true });
                  return;
                }
                const model = parseModelOptionKey(key);
                if (model) {
                  await rpc("models/setAuto", { enabled: false });
                  await rpc("models/setDefault", model);
                }
              })
            }
            style={styles.modelRow}
          >
            <Text style={styles.modelLabel}>{t("Active model")}</Text>
            <Text style={styles.secondary}>
              {routing.auto
                ? t("Auto")
                : (currentEntry?.label ?? me?.defaultModel ?? t("Deployment default"))}
            </Text>
          </NativeMenu>
          {routing.auto
            ? categoryLabels.map(({ category, label }) => {
                const assignment = routing.categories.find((item) => item.category === category);
                const key = assignment ? `${assignment.provider}::${assignment.modelId}` : "";
                const { levels } = thinkingChoices({ catalog, credentials, me }, key);
                return (
                  <View key={category}>
                    <NativeMenu
                      title={label}
                      accessibilityLabel={label}
                      disabled={routingBusy}
                      selected={key}
                      options={[
                        { value: "", label: t("Default") },
                        ...connectedOptions.map((option) => ({
                          value: option.key,
                          label: option.label,
                        })),
                      ]}
                      onSelect={(value) => void assignCategory(category, value)}
                      style={styles.modelRow}
                    >
                      <Text style={styles.modelLabel}>{label}</Text>
                      <Text style={styles.secondary}>
                        {connectedOptions.find((option) => option.key === key)?.label ??
                          assignment?.modelId ??
                          t("Default")}
                      </Text>
                    </NativeMenu>
                    {assignment && levels.length ? (
                      <NativeMenu
                        title={t("Reasoning effort")}
                        accessibilityLabel={t("Reasoning effort")}
                        disabled={routingBusy}
                        selected={assignment.thinkingLevel ?? ""}
                        options={[
                          { value: "", label: t("Default") },
                          ...levels.map((level) => ({
                            value: level,
                            label: thinkingLevelLabel(level),
                          })),
                        ]}
                        onSelect={(value) =>
                          void assignCategory(
                            category,
                            key,
                            levels.find((level) => level === value) ?? null,
                          )
                        }
                        style={styles.modelRow}
                      >
                        <Text style={styles.modelLabel}>{t("Reasoning effort")}</Text>
                        <Text style={styles.secondary}>
                          {assignment.thinkingLevel
                            ? thinkingLevelLabel(assignment.thinkingLevel)
                            : t("Default")}
                        </Text>
                      </NativeMenu>
                    ) : null}
                  </View>
                );
              })
            : null}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createModelsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      padding: 20,
      gap: 12,
      paddingBottom: 40,
    },
    secondary: {
      color: native.secondaryLabel,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 4,
    },
    card: {
      borderRadius: 14,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
    modelRow: {
      minHeight: 54,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
    },
    modelLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
      marginTop: 4,
    },
  });
}
