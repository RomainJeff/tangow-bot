import type { TrashedSkill } from "@rakazo/contracts";
import { Stack, useRouter } from "expo-router";
import { useEffect } from "react";
import { Alert, ScrollView, StyleSheet } from "react-native";
import { Group, LoadFailed, LoadingRows, Row, useFocusedRead } from "../components/bot-page/kit";
import { useDateLabel } from "../components/bot-page/skill-parts";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useResolvedAppearance, useThemedStyles } from "../lib/native";
import { serverMessage } from "../lib/server-error";
import { markRestored } from "../lib/skill-versions";

/** Skills deleted in the last 30 days: bring one back, or delete it for good. */
export default function BotSkillsTrashScreen() {
  const styles = useThemedStyles(createTrashStyles);
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const router = useRouter();
  const dateLabel = useDateLabel();
  const { read, setRead, retry } = useFocusedRead(
    () => rpc<TrashedSkill[]>("agentSkills/trash", {}),
    [],
  );

  const left = read.kind === "ready" ? read.value.length : null;
  useEffect(() => {
    if (left === 0) router.back();
  }, [left]);

  const restore = (skill: TrashedSkill) =>
    rpc<{ skillId: string; name: string; botGone: boolean }>("agentSkills/restore", {
      uid: skill.uid,
    }).then(
      ({ skillId, botGone }) => {
        markRestored({ skillId, botGone });
        router.back();
      },
      (error: unknown) => Alert.alert(serverMessage(error) || t("Could not restore")),
    );
  const purge = (skill: TrashedSkill) =>
    Alert.alert(t("Delete {name}?", { name: skill.name }), t("This cannot be undone."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete now"),
        style: "destructive",
        onPress: () => {
          rpc("agentSkills/purge", { uid: skill.uid }).then(
            () =>
              setRead((current) =>
                current.kind === "ready"
                  ? { kind: "ready", value: current.value.filter((item) => item.uid !== skill.uid) }
                  : current,
              ),
            (error: unknown) => Alert.alert(serverMessage(error) || t("Could not delete")),
          );
        },
      },
    ]);
  const open = (skill: TrashedSkill) =>
    presentMessageActionSheet({
      title: skill.name,
      actions: [
        { text: t("Undo"), onPress: () => void restore(skill) },
        { text: t("Delete now"), destructive: true, onPress: () => purge(skill) },
      ],
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });

  return (
    <>
      <Stack.Screen options={{ title: t("Recently deleted") }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        {read.kind === "failed" ? (
          <LoadFailed onRetry={retry} />
        ) : (
          <Group>
            {read.kind === "loading" ? (
              <LoadingRows />
            ) : (
              read.value.map((skill) => (
                <Row
                  key={skill.uid}
                  label={skill.name}
                  subline={dateLabel(skill.trashedAt)}
                  onPress={() => open(skill)}
                />
              ))
            )}
          </Group>
        )}
      </ScrollView>
    </>
  );
}

function createTrashStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48 },
  });
}
