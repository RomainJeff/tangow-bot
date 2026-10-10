import type { Routine } from "@rakazo/contracts";
import { draftFromRoutine, type RoutineDraft, triggerSave } from "@rakazo/core";
import { radii } from "@rakazo/ui-tokens";
import { Stack, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextStyle,
  View,
} from "react-native";
import {
  Group,
  InkSwitch,
  LoadFailed,
  LoadingRows,
  QuietLine,
  Row,
  SaveMeta,
} from "../components/bot-page/kit";
import { useRoutines } from "../components/bot-page/routines-tab";
import { WhenToRun } from "../components/bot-page/when-to-run";
import { mobileTokens } from "../lib/appearance";
import {
  type BotPageContext,
  type FieldSave,
  type RoutinePatch,
  readBotPage,
  readViewer,
  removeRoutine,
  updateRoutine,
  useBotField,
  useBotPageContext,
} from "../lib/bot-page";
import { botRunEpoch, subscribeBotRunEnds } from "../lib/bot-page-state";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { cadenceLine, draftError } from "../lib/routine-copy";
import { serverMessage } from "../lib/server-error";
import { leaveTextField, restingText } from "../lib/text-field";
import { nativeTextStyle } from "../lib/typography";
import { readWebhookKey } from "../lib/webhook-key";

/**
 * One routine, from the Routines tab, a link in a thread or search. Each part saves on its own,
 * like on the web. The bot's routines are read again on focus and when a run ends, since there
 * is no read of one routine.
 */
export default function BotRoutineScreen() {
  const { botId = "", routineId = "" } = useLocalSearchParams<{
    botId: string;
    routineId: string;
  }>();
  const styles = useThemedStyles(createRoutineStyles);
  const { t } = useI18n();
  const router = useRouter();
  const navigation = useNavigation();
  const page = useBotPageContext(botId);
  const epoch = useSyncExternalStore(
    subscribeBotRunEnds,
    () => botRunEpoch(botId),
    () => botRunEpoch(botId),
  );
  const { routines, read, retry } = useRoutines(botId, epoch);
  const known = routines?.find((item) => item.id === routineId);

  // Opened from a thread or search, the bot may not be read yet; a failed read offers Retry.
  const [botFailed, setBotFailed] = useState(false);
  const pageKnown = page !== null;
  const readBot = useCallback(() => {
    if (pageKnown || !botId) return;
    void Promise.all([readBotPage(botId), readViewer()]).then(
      () => setBotFailed(false),
      () => setBotFailed(true),
    );
  }, [botId, pageKnown]);
  useEffect(readBot, [readBot]);

  // Deleted here, the routine stays on screen while the screen slides away.
  const deletedHere = useRef(false);
  const lastShown = useRef(known);
  if (known) lastShown.current = known;
  const routine = known ?? (deletedHere.current ? lastShown.current : undefined);

  // A delete answering after the person swiped back must not pop the screen below too.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const remove = async () => {
    deletedHere.current = true;
    try {
      await removeRoutine(botId, routineId);
    } catch (error) {
      deletedHere.current = false;
      throw error;
    }
    if (mounted.current) router.back();
  };

  const state = navigation.getState();
  const fromBotPage = state?.routes[state.index - 1]?.name === "bot";

  return (
    <>
      <Stack.Screen
        options={{ title: "", headerBackTitle: fromBotPage ? t("Routines") : undefined }}
      />
      {page && routine ? (
        <RoutineDetail page={page} routine={routine} onDelete={remove} />
      ) : read === "ready" && routines && !routine ? (
        <QuietLine>{t("This routine no longer exists")}</QuietLine>
      ) : read === "failed" || botFailed ? (
        <LoadFailed
          onRetry={() => {
            setBotFailed(false);
            readBot();
            retry();
          }}
        />
      ) : (
        <View style={[styles.screen, styles.content]}>
          <Group>
            <LoadingRows />
          </Group>
        </View>
      )}
    </>
  );
}

function RoutineDetail({
  page,
  routine,
  onDelete,
}: {
  page: BotPageContext;
  routine: Routine;
  onDelete: () => Promise<void>;
}) {
  const styles = useThemedStyles(createRoutineStyles);
  const { t } = useI18n();
  const { bot } = page;
  const [deleting, setDeleting] = useState(false);
  const readOnly = page.readOnly || deleting;

  const update = (patch: RoutinePatch) => updateRoutine(bot.id, routine.id, patch);
  const useField = <K extends "name" | "prompt" | "notify" | "requireToolApproval" | "active">(
    field: K,
  ): FieldSave<Routine[K]> =>
    useBotField(page, `routine:${routine.id}:${field}`, routine[field], (value) =>
      update({ [field]: value }),
    );
  const name = useField("name");
  const prompt = useField("prompt");
  const active = useField("active");
  const notify = useField("notify");
  const approval = useField("requireToolApproval");
  const draft = draftFromRoutine(routine, () => new Date());
  const inbound =
    routine.webhookEnabled || routine.githubEnabled || Boolean(routine.messageProvider);

  const saveTriggers = async (next: RoutineDraft, armOneShot: boolean): Promise<string | null> => {
    const checked = triggerSave(routine, next, () => new Date(), armOneShot);
    if (!checked.ok) return draftError(checked.error);
    if (Object.keys(checked.patch).length === 0) return null;
    try {
      if (checked.needsWebhookKey && !bot.webhookConfigured) await readWebhookKey(bot.id);
      await update(checked.patch);
      return null;
    } catch (error) {
      return serverMessage(error) || t("Could not save");
    }
  };

  const confirmDelete = () =>
    Alert.alert(t("Delete {name}?", { name: routine.name }), t("This cannot be undone."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () => {
          setDeleting(true);
          void onDelete().catch((error: unknown) => {
            setDeleting(false);
            Alert.alert(t("Could not delete routine"), serverMessage(error) || t("Try again."));
          });
        },
      },
    ]);

  const metaField =
    [name, active].find((field) => field.state.kind === "failed") ??
    [name, active].find((field) => field.state.kind !== "idle") ??
    name;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.head}>
        <View style={styles.titleLine}>
          <RoutineText
            field={name}
            label={t("Name")}
            maxLength={80}
            disabled={readOnly}
            style={styles.name}
          />
          <InkSwitch
            accessibilityLabel={t("Active: {name}", { name: routine.name })}
            value={active.value}
            disabled={readOnly}
            onValueChange={(value) => void active.save(value)}
          />
        </View>
        <View style={styles.statusLine}>
          <Text style={styles.status} numberOfLines={2}>
            {cadenceLine({ ...routine, active: active.value })}
          </Text>
          <SaveMeta state={metaField.state} onRetry={() => void metaField.retry()} />
        </View>
      </View>

      <Group label={t("Instruction")}>
        <View style={styles.promptBox}>
          <RoutineText
            field={prompt}
            label={t("Instruction")}
            paragraphs
            keepDraft
            disabled={readOnly}
            placeholder={t("What should this routine do each time it runs?")}
            style={styles.prompt}
          />
        </View>
      </Group>

      <WhenToRun
        draft={draft}
        existing={routine}
        botId={bot.id}
        disabled={readOnly}
        onSave={saveTriggers}
      />

      <Group>
        {inbound ? (
          <Row
            label={t("Ask before every action")}
            meta={<SaveMeta state={approval.state} onRetry={() => void approval.retry()} />}
            control={
              <InkSwitch
                accessibilityLabel={t("Ask before every action")}
                value={approval.value}
                disabled={readOnly}
                onValueChange={(value) => void approval.save(value)}
              />
            }
          />
        ) : null}
        <Row
          label={t("Notify me")}
          meta={<SaveMeta state={notify.state} onRetry={() => void notify.retry()} />}
          control={
            <InkSwitch
              accessibilityLabel={t("Notify me")}
              value={notify.value}
              disabled={readOnly}
              onValueChange={(value) => void notify.save(value)}
            />
          }
        />
      </Group>

      {page.readOnly ? null : (
        <Group>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: deleting }}
            disabled={deleting}
            onPress={confirmDelete}
            style={({ pressed }) => [styles.delete, pressed && styles.pressed]}
          >
            <Text style={styles.deleteLabel}>{t("Delete routine")}</Text>
          </Pressable>
        </Group>
      )}
    </ScrollView>
  );
}

/**
 * Text edited in place, saved when it loses focus and only when the trimmed text changed.
 * Emptied, it turns back to the saved text. `keepDraft` holds unsaved text for the session.
 */
function RoutineText({
  field,
  label,
  maxLength,
  paragraphs,
  keepDraft,
  placeholder,
  disabled,
  style,
}: {
  field: FieldSave<string>;
  label: string;
  maxLength?: number;
  /** Return starts a new line; otherwise it leaves the field. Both wrap, so a long name stays readable. */
  paragraphs?: boolean;
  keepDraft?: boolean;
  placeholder?: string;
  disabled: boolean;
  style: StyleProp<TextStyle>;
}) {
  const styles = useThemedStyles(createRoutineStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const resting = restingText(field);
  const restored = keepDraft && field.draft && !field.conflict ? field.draft.value : null;
  const [text, setText] = useState(restored ?? resting);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing && !restored) setText(resting);
  }, [editing, resting, restored]);
  // The saved text moved while unsaved text waited: show the saved one and offer the other back.
  const restorable = keepDraft && field.conflict ? field.draft : undefined;

  const change = (next: string) => {
    setText(next);
    if (keepDraft) field.setDraft(next.trim() === field.value.trim() ? null : next);
  };

  // Once left, the text is either saved, put back, or kept by a failed save for Retry.
  const commit = () => {
    setEditing(false);
    leaveTextField(field, text, { required: true });
    if (keepDraft) field.setDraft(null);
  };

  const input = (
    <TextInput
      accessibilityLabel={label}
      value={text}
      onChangeText={change}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      editable={!disabled}
      maxLength={maxLength}
      multiline
      placeholder={placeholder}
      placeholderTextColor={tokens.mutedForeground}
      returnKeyType={paragraphs ? "default" : "done"}
      submitBehavior={paragraphs ? "newline" : "blurAndSubmit"}
      scrollEnabled={false}
      textAlignVertical="top"
      style={style}
    />
  );
  if (!keepDraft) return input;
  return (
    <>
      {input}
      {restorable && !editing ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => setText(restorable.value)}
          style={styles.restore}
        >
          <Text style={styles.restoreLabel}>{t("Restore unsaved text")}</Text>
        </Pressable>
      ) : (
        <SaveMeta state={field.state} onRetry={() => void field.retry()} />
      )}
    </>
  );
}

function createRoutineStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 28 },
    head: { gap: 6, paddingHorizontal: 4 },
    titleLine: { flexDirection: "row", alignItems: "center", gap: 12 },
    name: {
      flex: 1,
      paddingVertical: 2,
      color: tokens.foreground,
      ...nativeTextStyle("title", { size: 24, weight: 600 }),
    },
    statusLine: { gap: 3 },
    status: { color: tokens.mutedForeground, ...nativeTextStyle("meta", { size: 14 }) },
    promptBox: { paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
    prompt: {
      minHeight: 72,
      padding: 0,
      color: tokens.foreground,
      ...nativeTextStyle("body", { size: 16, leading: 1.45 }),
    },
    delete: {
      minHeight: 52,
      justifyContent: "center",
      paddingHorizontal: 16,
      borderRadius: radii.card,
    },
    pressed: { backgroundColor: tokens.accent },
    deleteLabel: { color: tokens.destructive, ...nativeTextStyle("composer") },
    restore: { alignSelf: "flex-start" },
    restoreLabel: {
      color: tokens.foreground,
      ...nativeTextStyle("meta", { size: 14, weight: 500 }),
    },
  });
}
