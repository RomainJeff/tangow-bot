import type { BotSecretDestination } from "@tangow/contracts";
import { Stack, useRouter } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { Group, LoadFailed, LoadingRows, Row, useFocusedRead } from "../components/bot-page/kit";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";

/** The person's credentials in this space: name and site; values are never read back. */
export default function Vault() {
  const { t } = useI18n();
  const router = useRouter();
  const styles = useThemedStyles(createVaultStyles);
  const { read, retry } = useFocusedRead(() => rpc<BotSecretDestination[]>("vault/list"), []);
  const open = (item?: BotSecretDestination) =>
    router.push({ pathname: "/vault-item", params: item ? { item: JSON.stringify(item) } : {} });

  return (
    <>
      <Stack.Screen
        options={{
          unstable_headerRightItems: () => [
            { type: "button", label: t("Add"), onPress: () => open() },
          ],
        }}
      />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        {read.kind === "loading" ? (
          <LoadingRows />
        ) : read.kind === "failed" ? (
          <LoadFailed onRetry={retry} />
        ) : (
          <Group>
            {read.value.map((item) => (
              <Row
                key={item.name}
                label={item.name}
                subline={new URL(item.origin).host}
                chevron
                onPress={() => open(item)}
              />
            ))}
          </Group>
        )}
      </ScrollView>
    </>
  );
}

function createVaultStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48, gap: 28 },
  });
}
