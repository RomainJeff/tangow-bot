import { Pressable, Text, View } from "react-native";
import type { MobileModel, MobileModelCredential } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useThemedStyles } from "../../lib/native";
import { createProvidersStyles } from "./styles";

type ProviderGroup = { id: string; name: string; entries: MobileModel[] };

/** The model providers, featured first, with the rest behind Show more. */
export function ModelProviderList({
  groups,
  credentials,
  selected,
  expandable,
  expanded,
  onToggleExpanded,
  onSelect,
}: {
  groups: ProviderGroup[];
  credentials: MobileModelCredential[];
  selected: string | null;
  expandable: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelect: (provider: string) => void;
}) {
  const styles = useThemedStyles(createProvidersStyles);
  const { t } = useI18n();
  return (
    <>
      <Text style={styles.sectionTitle}>{t("Models")}</Text>
      <View style={styles.card}>
        {groups.map((group) => {
          const connected = credentials.some((entry) => entry.provider === group.id);
          return (
            <Pressable
              key={group.id}
              accessibilityRole="button"
              accessibilityState={{ selected: group.id === selected }}
              onPress={() => onSelect(group.id)}
              style={({ pressed }) => [
                styles.providerRow,
                group.id === selected && styles.selectedRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.providerCopy}>
                <Text style={styles.providerName}>{group.name}</Text>
                <Text style={styles.secondary}>
                  {t(group.entries.length === 1 ? "{count} model" : "{count} models", {
                    count: group.entries.length,
                  })}
                </Text>
              </View>
              {connected ? <Text style={styles.connected}>{t("Connected")}</Text> : null}
            </Pressable>
          );
        })}
        {expandable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={onToggleExpanded}
            style={styles.providerRow}
          >
            <Text style={styles.providerName}>{expanded ? t("Show less") : t("Show more")}</Text>
          </Pressable>
        ) : null}
      </View>
    </>
  );
}
