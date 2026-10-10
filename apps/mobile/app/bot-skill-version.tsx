import type { SkillVersionDetail } from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Alert, ScrollView, StyleSheet, Text } from "react-native";
import { Group, LoadFailed, Row, useFocusedRead } from "../components/bot-page/kit";
import { MoreButton, useDateLabel } from "../components/bot-page/skill-parts";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useResolvedAppearance, useThemedStyles } from "../lib/native";
import { serverMessage } from "../lib/server-error";
import { versionSubline } from "../lib/skill-versions";
import { nativeTextStyle } from "../lib/typography";

/** One past version, read only: its SKILL.md and the files it held. */
export default function BotSkillVersionScreen() {
  const { skillId = "", versionId = "" } = useLocalSearchParams<{
    skillId: string;
    versionId: string;
  }>();
  const styles = useThemedStyles(createVersionStyles);
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const router = useRouter();
  const dateLabel = useDateLabel();
  const { read, retry } = useFocusedRead(
    () => rpc<SkillVersionDetail>("agentSkills/version", { skillId, versionId }),
    [skillId, versionId],
  );
  const version = read.kind === "ready" ? read.value : null;

  const confirmDelete = () =>
    Alert.alert(t("Delete this version?"), t("This cannot be undone."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          rpc("agentSkills/deleteVersion", { skillId, versionId }).then(
            () => router.back(),
            (error: unknown) => Alert.alert(serverMessage(error) || t("Could not delete")),
          );
        },
      },
    ]);
  const more = () =>
    presentMessageActionSheet({
      actions: [{ text: t("Delete"), destructive: true, onPress: confirmDelete }],
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });

  return (
    <>
      <Stack.Screen
        options={{
          title: version ? dateLabel(version.createdAt) : "",
          // The current version stays: the server refuses it.
          headerRight: () =>
            version && !version.current ? <MoreButton label={t("More")} onPress={more} /> : null,
        }}
      />
      {read.kind === "failed" ? (
        <LoadFailed onRetry={retry} />
      ) : version ? (
        <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
          <Text style={styles.meta}>
            {versionSubline(version, {
              learned: t("learned"),
              updated: t("updated"),
              you: t("You"),
              undone: t("Undone"),
              unknown: t("Updated"),
            })}
          </Text>
          <Text selectable style={styles.body}>
            {version.content}
          </Text>
          {version.files.length > 0 ? (
            <Group>
              {version.files.map((file) => (
                <Row key={file.path} label={file.path} />
              ))}
            </Group>
          ) : null}
        </ScrollView>
      ) : null}
    </>
  );
}

function createVersionStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48, gap: 20 },
    meta: {
      paddingHorizontal: 4,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta", { size: 14 }),
    },
    body: {
      paddingHorizontal: 4,
      color: tokens.foreground,
      ...nativeTextStyle("body", { size: 16, leading: 1.5 }),
    },
  });
}
