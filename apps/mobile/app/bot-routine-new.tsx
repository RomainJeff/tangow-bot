import type { Routine } from "@rakazo/contracts";
import { emptyRoutineDraft, type RoutineDraft, validateRoutineDraft } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Group, InkSwitch, Row } from "../components/bot-page/kit";
import { SpokenError } from "../components/bot-page/spoken-error";
import { WhenToRun } from "../components/bot-page/when-to-run";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { type BotPageContext, useBotPageContext } from "../lib/bot-page";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { draftError } from "../lib/routine-copy";
import { serverMessage } from "../lib/server-error";
import { nativeTextStyle } from "../lib/typography";
import { readWebhookKey } from "../lib/webhook-key";

/**
 * A new routine. Unlike the rest of the page it is a form with one Create:
 * without a trigger a routine does not exist yet, so nothing saves until it is whole.
 */
export default function NewRoutineScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const page = useBotPageContext(botId);
  return page ? <NewRoutineForm page={page} /> : null;
}

function NewRoutineForm({ page }: { page: BotPageContext }) {
  const styles = useThemedStyles(createNewRoutineStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const router = useRouter();
  const { bot } = page;
  const [draft, setDraft] = useState<RoutineDraft>(emptyRoutineDraft);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const inbound = draft.webhookEnabled || draft.githubEnabled || Boolean(draft.messageProvider);
  const patch = (partial: Partial<RoutineDraft>) =>
    setDraft((current) => ({ ...current, ...partial }));

  const open = (routineId: string) =>
    router.replace({ pathname: "/bot-routine", params: { botId: bot.id, routineId } });

  const create = async () => {
    const checked = validateRoutineDraft(draft, null, () => new Date(), {
      name: t("Routine"),
      prompt: t("Check in."),
    });
    if (!checked.ok) {
      setError(draftError(checked.error));
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const needsKey = (draft.webhookEnabled || draft.githubEnabled) && !bot.webhookConfigured;
      if (needsKey) await readWebhookKey(bot.id);
      // Scheduled in the device's timezone, like on the web.
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const created = await rpc<Routine>("routines/create", {
        botId: bot.id,
        timezone,
        ...checked.payload,
      });
      open(created.id);
    } catch (failure) {
      setError(serverMessage(failure) || t("Could not save routine"));
      setCreating(false);
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: t("New routine"),
          unstable_headerRightItems: () => [
            {
              type: "button",
              label: creating ? t("Creating…") : t("Create"),
              variant: "done",
              disabled: creating || page.readOnly,
              onPress: () => void create(),
            },
          ],
        }}
      />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
      >
        <Group label={t("Name")}>
          <View style={styles.field}>
            <TextInput
              accessibilityLabel={t("Name")}
              value={draft.name}
              onChangeText={(name) => patch({ name })}
              maxLength={80}
              placeholder={t("Name this routine")}
              placeholderTextColor={tokens.mutedForeground}
              returnKeyType="done"
              style={styles.input}
            />
          </View>
        </Group>
        <Group label={t("Instruction")}>
          <View style={styles.field}>
            <TextInput
              accessibilityLabel={t("Instruction")}
              value={draft.prompt}
              onChangeText={(prompt) => patch({ prompt })}
              multiline
              scrollEnabled={false}
              placeholder={t("What should this routine do each time it runs?")}
              placeholderTextColor={tokens.mutedForeground}
              textAlignVertical="top"
              style={[styles.input, styles.prompt]}
            />
          </View>
        </Group>
        <WhenToRun
          draft={draft}
          existing={null}
          botId={bot.id}
          disabled={creating}
          onSave={async (next) => {
            setDraft(next);
            setError(null);
            return null;
          }}
        />
        <Group>
          <Row
            label={t("Active")}
            control={
              <InkSwitch
                accessibilityLabel={t("Active")}
                value={draft.active}
                onValueChange={(active) => patch({ active })}
              />
            }
          />
          {inbound ? (
            <Row
              label={t("Ask before every action")}
              control={
                <InkSwitch
                  accessibilityLabel={t("Ask before every action")}
                  value={draft.requireToolApproval}
                  onValueChange={(requireToolApproval) => patch({ requireToolApproval })}
                />
              }
            />
          ) : null}
          <Row
            label={t("Notify me")}
            control={
              <InkSwitch
                accessibilityLabel={t("Notify me")}
                value={draft.notify}
                onValueChange={(notify) => patch({ notify })}
              />
            }
          />
        </Group>
        <SpokenError>{error}</SpokenError>
      </ScrollView>
    </>
  );
}

function createNewRoutineStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48, gap: 28 },
    field: { paddingHorizontal: 16, paddingVertical: 14 },
    input: { padding: 0, color: tokens.foreground, ...nativeTextStyle("composer") },
    prompt: { minHeight: 72, ...nativeTextStyle("body", { size: 16, leading: 1.45 }) },
  });
}
