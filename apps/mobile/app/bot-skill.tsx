import type { AgentSkill, SkillVersion } from "@rakazo/contracts";
import { canUndoSkillVersion, showsSkillVersions } from "@rakazo/core";
import { motion } from "@rakazo/ui-tokens";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import {
  Alert,
  Keyboard,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { Group, GroupAction, LoadFailed, Row, useFocusedRead } from "../components/bot-page/kit";
import { MoreButton, useDateLabel, useVersionSubline } from "../components/bot-page/skill-parts";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useChatReducedMotion } from "../lib/chat-motion";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { native, useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { serverMessage } from "../lib/server-error";
import { skillDirty, skillText } from "../lib/skill-draft";
import { type UndoOutcome, undoOutcome } from "../lib/skill-versions";
import { nativeTextStyle } from "../lib/typography";

type Loaded = { skill: AgentSkill; versions: SkillVersion[] };

async function loadSkill(skillId: string): Promise<Loaded> {
  const skill = await rpc<AgentSkill>("agentSkills/get", { skillId });
  // Only a skill the owner wrote has a history; builtin and marketplace ones are read-only.
  const versions = skill.readOnly
    ? []
    : await rpc<SkillVersion[]>("agentSkills/versions", { skillId });
  return { skill, versions };
}

/**
 * One skill's SKILL.md, edited like a memory document with Cancel and Save, then its versions.
 * The id changes when the name does, so the one a save or an Undo returns is the one kept.
 */
export default function BotSkillScreen() {
  const { skillId: linked = "" } = useLocalSearchParams<{ botId: string; skillId: string }>();
  const [skillId, setSkillId] = useState(linked);
  const styles = useThemedStyles(createSkillStyles);
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const router = useRouter();
  const reducedMotion = useChatReducedMotion();
  const dateLabel = useDateLabel();
  const versionSubline = useVersionSubline();
  const { read, setRead, retry } = useFocusedRead(() => loadSkill(skillId), [skillId]);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const loaded = read.kind === "ready" ? read.value : null;
  const content = loaded?.skill.content ?? null;
  const editing = draft !== null;
  const dirty = skillDirty(content, draft);

  const show = (next: Loaded) => {
    if (!reducedMotion) {
      LayoutAnimation.configureNext({
        duration: motion.arrive,
        update: { type: LayoutAnimation.Types.easeInEaseOut },
      });
    }
    setRead({ kind: "ready", value: next });
  };

  const stopEditing = () => {
    Keyboard.dismiss();
    setDraft(null);
  };
  const cancel = () => {
    if (!dirty) {
      stopEditing();
      return;
    }
    Alert.alert(t("Discard changes?"), undefined, [
      { text: t("Keep editing"), style: "cancel" },
      {
        text: t("Discard"),
        style: "destructive",
        onPress: stopEditing,
      },
    ]);
  };
  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setFailed(false);
    try {
      const saved = await rpc<AgentSkill>("agentSkills/update", { skillId, content: draft ?? "" });
      setSkillId(saved.id);
      show(await loadSkill(saved.id));
      stopEditing();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (versions: SkillVersion[]) => {
    const current = versions.find((version) => version.current);
    if (!current || busy) return;
    setBusy(true);
    const outcome: UndoOutcome = await undoOutcome(() =>
      rpc("agentSkills/undo", { skillId, expectedVersionId: current.versionId }),
    );
    try {
      if (outcome.kind === "trashed") {
        router.back();
        return;
      }
      if (outcome.kind === "restored") setSkillId(outcome.skillId);
      else Alert.alert(outcome.message || t("Could not undo"));
      show(await loadSkill(outcome.kind === "restored" ? outcome.skillId : skillId));
    } catch {
      retry();
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    presentMessageActionSheet({
      actions: [
        {
          text: t("Delete"),
          destructive: true,
          onPress: () => {
            rpc("agentSkills/remove", { skillId }).then(
              () => router.back(),
              (error: unknown) => Alert.alert(serverMessage(error) || t("Could not delete skill")),
            );
          },
        },
      ],
      colorScheme,
      cancel: t("Cancel"),
      more: t("More"),
    });

  const writable = loaded !== null && !loaded.skill.readOnly;
  return (
    <>
      <Stack.Screen
        options={{
          title: loaded?.skill.name ?? "",
          // Every key is set in both modes: options merge, so a key left out keeps the
          // editing value and the screen would stay without a way back.
          headerBackVisible: !editing,
          gestureEnabled: !editing,
          // Android: the bar buttons below are iOS only, so a plain Cancel and Save stand in.
          headerLeft: editing
            ? () => (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  hitSlop={8}
                  onPress={cancel}
                  style={styles.headerCancel}
                >
                  <Text style={styles.headerCancelLabel}>{t("Cancel")}</Text>
                </Pressable>
              )
            : undefined,
          unstable_headerLeftItems: editing
            ? () => [
                {
                  type: "button",
                  label: t("Cancel"),
                  variant: "plain",
                  disabled: busy,
                  onPress: cancel,
                },
              ]
            : undefined,
          unstable_headerRightItems: editing
            ? () => [
                {
                  type: "button",
                  label: busy ? t("Saving…") : t("Save"),
                  variant: "done",
                  disabled: busy || !dirty,
                  onPress: () => void save(),
                },
              ]
            : undefined,
          headerRight: editing
            ? () => (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || !dirty}
                  hitSlop={8}
                  onPress={() => void save()}
                  style={busy || !dirty ? styles.headerDisabled : undefined}
                >
                  <Text style={styles.headerSaveLabel}>{busy ? t("Saving…") : t("Save")}</Text>
                </Pressable>
              )
            : () => (writable ? <MoreButton label={t("More")} onPress={remove} /> : null),
        }}
      />
      {read.kind === "failed" ? (
        <LoadFailed onRetry={retry} />
      ) : loaded ? (
        <ScrollView
          style={styles.screen}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
        >
          {failed ? <Text style={styles.error}>{t("Could not save")}</Text> : null}
          <TextInput
            accessibilityLabel={loaded.skill.name}
            value={skillText(content, draft)}
            onChangeText={setDraft}
            onFocus={() => setDraft((current) => current ?? content ?? "")}
            editable={writable && !busy}
            multiline
            scrollEnabled={false}
            textAlignVertical="top"
            placeholderTextColor={tokens.mutedForeground}
            style={styles.field}
          />
          {writable && showsSkillVersions(loaded.versions) ? (
            <Group
              label={t("Versions")}
              trailing={
                canUndoSkillVersion(loaded.versions) && !editing ? (
                  <GroupAction label={t("Undo")} onPress={() => void undo(loaded.versions)} />
                ) : null
              }
            >
              {loaded.versions.map((version) => (
                <Dimmed key={version.versionId} dimmed={version.undone}>
                  <Row
                    label={dateLabel(version.createdAt)}
                    subline={versionSubline(version)}
                    checked={version.current}
                    onPress={() =>
                      router.push({
                        pathname: "/bot-skill-version",
                        params: { skillId, versionId: version.versionId },
                      })
                    }
                  />
                </Dimmed>
              ))}
            </Group>
          ) : null}
        </ScrollView>
      ) : null}
    </>
  );
}

/** An undone version greys out over the layout transition; nothing moves under Reduce Motion. */
function Dimmed({ dimmed, children }: { dimmed: boolean; children: ReactNode }) {
  const reducedMotion = useChatReducedMotion();
  const style = useAnimatedStyle(() => ({
    opacity: reducedMotion
      ? dimmed
        ? 0.45
        : 1
      : withTiming(dimmed ? 0.45 : 1, { duration: motion.arrive }),
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function createSkillStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingBottom: 48, gap: 28 },
    headerCancel: { paddingEnd: 20, paddingVertical: 8, justifyContent: "center" },
    headerCancelLabel: { color: native.label, ...nativeTextStyle("body", { size: 17 }) },
    headerSaveLabel: {
      color: tokens.primary,
      ...nativeTextStyle("body", { size: 16, weight: 600 }),
    },
    headerDisabled: { opacity: 0.4 },
    error: { color: tokens.destructive, ...nativeTextStyle("meta", { size: 14 }) },
    field: {
      paddingHorizontal: 4,
      paddingTop: 16,
      color: tokens.foreground,
      ...nativeTextStyle("body", { size: 16, leading: 1.5 }),
    },
  });
}
