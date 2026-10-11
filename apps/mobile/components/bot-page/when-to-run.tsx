import { Button, DatePicker, Host, Menu, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import {
  datePickerStyle,
  disabled as disabledWhen,
  font,
  labelsHidden,
  pickerStyle,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { Routine } from "@rakazo/contracts";
import {
  applyTriggerEdit,
  CRON_FREQS,
  type CronFreq,
  type CronPreset,
  type CronUnit,
  cronFromPreset,
  formatClock,
  newScheduleEdit,
  parseClock,
  type RoutineDraft,
  removeTriggerEffect,
  routineTriggers,
  type TriggerEdit,
  toDatetimeLocalValue,
  triggerEditArmsOneShot,
  triggerEditFor,
  triggerEditRef,
  withoutTrigger,
} from "@rakazo/core";
import { radii } from "@rakazo/ui-tokens";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { currentApiBase, rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { deviceTimezone } from "../../lib/bot-page";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import {
  describeSchedule,
  draftError,
  freqLabel,
  messageLabel,
  triggerLabel,
  unitLabel,
} from "../../lib/routine-copy";
import { serverMessage } from "../../lib/server-error";
import { nativeTextStyle } from "../../lib/typography";
import { readWebhookKey, rotateWebhookKey } from "../../lib/webhook-key";
import { NativeSymbol } from "../native-symbol";
import { Group, Row, useFocusedRead } from "./kit";
import { SpokenError } from "./spoken-error";

// The trigger menu and sheets are SwiftUI views. Android ships no build of this app yet, so there
// the triggers are listed without editing rather than rendering views it does not register.
export const EDITS_TRIGGERS = Platform.OS === "ios";

const TIMED: readonly CronFreq[] = ["Every day", "Weekdays", "Every week", "Every month"];
const AMOUNTS = [1, 2, 3, 5, 10, 15, 30, 45];
const UNITS: readonly CronUnit[] = ["minutes", "hours", "days"];

/**
 * "When to run": a row per trigger, each opening its sheet, and the menu that adds one.
 * `onSave` gets the whole draft with the change, and whether the sheet asked when a one-shot
 * runs, and answers with an error to show in the sheet, or null once it is applied.
 */
export function WhenToRun({
  draft,
  existing,
  botId,
  disabled,
  onSave,
}: {
  draft: RoutineDraft;
  existing: Routine | null;
  botId: string;
  disabled: boolean;
  onSave: (next: RoutineDraft, armOneShot: boolean) => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [edit, setEdit] = useState<TriggerEdit | null>(null);
  // Slack and Teams triggers need the provider mounted on the server; a failed read offers neither.
  const { read: messaging } = useFocusedRead(
    () => rpc<{ providers: string[] }>("messaging/status"),
    [],
  );
  const messageProviders = messaging.kind === "ready" ? messaging.value.providers : [];
  const triggers = routineTriggers(draft);
  const timezone = existing?.timezone ?? deviceTimezone();

  return (
    <>
      <Group
        label={t("When to run")}
        trailing={
          EDITS_TRIGGERS ? (
            <AddTriggerMenu
              draft={draft}
              messageProviders={messageProviders}
              disabled={disabled}
              onAdd={setEdit}
            />
          ) : null
        }
      >
        {triggers.map((trigger) => {
          const preset = trigger.kind === "schedule" ? draft.schedules[trigger.index] : null;
          return (
            <Row
              key={trigger.kind === "schedule" ? `schedule-${trigger.index}` : trigger.kind}
              label={triggerLabel(draft, trigger)}
              subline={
                preset ? `${describeSchedule(cronFromPreset(preset))} · ${timezone}` : undefined
              }
              chevron={EDITS_TRIGGERS}
              disabled={disabled}
              onPress={EDITS_TRIGGERS ? () => setEdit(triggerEditFor(draft, trigger)) : undefined}
            />
          );
        })}
      </Group>
      {edit ? (
        <TriggerSheet
          key={edit.kind === "schedule" ? `schedule-${edit.index}` : edit.kind}
          initial={edit}
          draft={draft}
          existing={existing}
          botId={botId}
          onSave={onSave}
          onClose={() => setEdit(null)}
        />
      ) : null}
    </>
  );
}

/** The native menu that adds a trigger; Slack and Teams only once the space has them connected. */
function AddTriggerMenu({
  draft,
  messageProviders,
  disabled,
  onAdd,
}: {
  draft: RoutineDraft;
  messageProviders: string[];
  disabled: boolean;
  onAdd: (edit: TriggerEdit) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  // A native view has no text baseline, so it centres on the group label's line instead.
  return (
    <Host matchContents colorScheme={scheme} style={{ alignSelf: "center" }}>
      <Menu
        label={
          <SwiftText modifiers={[font({ size: 14 }), tint(tokens.mutedForeground)]}>
            {t("Add trigger")}
          </SwiftText>
        }
        modifiers={[tint(tokens.mutedForeground), disabledWhen(disabled)]}
      >
        <Menu label={t("On a schedule")} systemImage="clock">
          {CRON_FREQS.map((freq) => (
            <Button
              key={freq}
              label={freqLabel(freq)}
              onPress={() => onAdd(newScheduleEdit(draft, freq))}
            />
          ))}
        </Menu>
        {(["slack", "teams"] as const).map((provider) => (
          <Button
            key={provider}
            label={messageLabel(provider)}
            systemImage="message"
            modifiers={[
              disabledWhen(Boolean(draft.messageProvider) || !messageProviders.includes(provider)),
            ]}
            onPress={() => onAdd({ kind: "message", provider, adding: true })}
          />
        ))}
        <Button
          label={t("Git event")}
          systemImage="arrow.triangle.branch"
          modifiers={[disabledWhen(draft.githubEnabled)]}
          onPress={() => onAdd({ kind: "github", adding: true })}
        />
        <Button
          label={t("Webhook")}
          systemImage="globe"
          modifiers={[disabledWhen(draft.webhookEnabled)]}
          onPress={() => onAdd({ kind: "webhook", adding: true })}
        />
      </Menu>
    </Host>
  );
}

/** One trigger in a native sheet: Done checks and saves it, Remove asks first when an inbound URL stops working. */
function TriggerSheet({
  initial,
  draft,
  existing,
  botId,
  onSave,
  onClose,
}: {
  initial: TriggerEdit;
  draft: RoutineDraft;
  existing: Routine | null;
  botId: string;
  onSave: (next: RoutineDraft, armOneShot: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createSheetStyles);
  const { t } = useI18n();
  const [edit, setEdit] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = triggerEditRef(edit);
  const armOneShot = triggerEditArmsOneShot(draft, edit, existing);
  const title =
    edit.kind === "schedule"
      ? t("On a schedule")
      : edit.kind === "message"
        ? messageLabel(edit.provider)
        : edit.kind === "github"
          ? t("Git event")
          : t("When a webhook fires");

  const inbound = edit.kind === "webhook" || edit.kind === "github" ? edit.kind : null;

  const save = async (next: RoutineDraft, arm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const failure = await onSave(next, arm);
      if (failure) setError(failure);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!ref) return;
    const effect = removeTriggerEffect(draft, ref);
    if (effect === "last_trigger") {
      setError(draftError({ code: "no_trigger" }));
      return;
    }
    if (effect === "confirm") {
      const confirmed = await new Promise<boolean>((resolve) =>
        Alert.alert(
          ref.kind === "webhook"
            ? t("Remove webhook?")
            : ref.kind === "github"
              ? t("Remove Git event?")
              : t("Remove message trigger?"),
          undefined,
          [
            { text: t("Cancel"), style: "cancel", onPress: () => resolve(false) },
            { text: t("Remove"), style: "destructive", onPress: () => resolve(true) },
          ],
        ),
      );
      if (!confirmed) return;
    }
    await save(withoutTrigger(draft, ref), false);
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <View style={styles.sheet}>
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {edit.kind === "schedule" ? (
            <ScheduleFields
              preset={edit.preset}
              runAtLocal={armOneShot ? edit.runAtLocal : null}
              onPreset={(preset) => setEdit({ ...edit, preset })}
              onRunAt={(runAtLocal) => setEdit({ ...edit, runAtLocal })}
            />
          ) : edit.kind === "message" ? (
            <Text style={styles.note}>
              {t("Runs when this bot receives a verified message from this provider.")}
            </Text>
          ) : inbound ? (
            <InboundDetails kind={inbound} botId={botId} saved={existing !== null} />
          ) : null}
          <SpokenError>{error}</SpokenError>
        </ScrollView>
        <View style={styles.actions}>
          {ref ? (
            <SheetAction label={t("Remove")} tone="destructive" busy={busy} onPress={remove} />
          ) : null}
          <View style={styles.spacer} />
          <SheetAction label={t("Cancel")} tone="muted" busy={busy} onPress={onClose} />
          <SheetAction
            label={busy ? t("Saving…") : t("Done")}
            tone="primary"
            busy={busy}
            onPress={() => save(applyTriggerEdit(draft, edit), armOneShot)}
          />
        </View>
      </View>
    </Modal>
  );
}

/** A text button on the sheet's last line: Remove alone on the left, Cancel then Done on the right. */
function SheetAction({
  label,
  tone,
  busy,
  onPress,
}: {
  label: string;
  tone: "destructive" | "muted" | "primary";
  busy: boolean;
  onPress: () => unknown;
}) {
  const styles = useThemedStyles(createSheetStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      hitSlop={10}
      onPress={() => void onPress()}
      style={styles.action}
    >
      <Text style={[styles.actionLabel, styles[tone], busy && styles.dimmed]}>{label}</Text>
    </Pressable>
  );
}

/** A preset's time of day as a date the native picker can show. */
function clockDate(time: string): Date {
  const { hour, minute } = parseClock(time);
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

function ScheduleFields({
  preset,
  runAtLocal,
  onPreset,
  onRunAt,
}: {
  preset: CronPreset;
  /** Null unless the saved routine is a one-shot that still needs its time. */
  runAtLocal: string | null;
  onPreset: (preset: CronPreset) => void;
  onRunAt: (runAtLocal: string) => void;
}) {
  const styles = useThemedStyles(createSheetStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const amounts = AMOUNTS.includes(preset.n)
    ? AMOUNTS
    : [...AMOUNTS, preset.n].sort((a, b) => a - b);
  const patch = (partial: Partial<CronPreset>) => onPreset({ ...preset, ...partial });

  return (
    <Group>
      <Row
        label={t("How often")}
        control={
          <NativeMenuPicker
            label={t("How often")}
            selection={preset.freq}
            options={CRON_FREQS.map((freq) => ({ value: freq, label: freqLabel(freq) }))}
            onChange={(freq) =>
              patch(freq === "Advanced" ? { freq, cron: cronFromPreset(preset) } : { freq })
            }
          />
        }
      />
      {preset.freq === "Interval" ? (
        <Row
          label={t("Every")}
          control={
            <View style={styles.pair}>
              <NativeMenuPicker
                label={t("Interval amount")}
                selection={preset.n}
                options={amounts.map((n) => ({ value: n, label: String(n) }))}
                onChange={(n) => patch({ n })}
              />
              <NativeMenuPicker
                label={t("Interval unit")}
                selection={preset.unit}
                options={UNITS.map((unit) => ({ value: unit, label: unitLabel(preset.n, unit) }))}
                onChange={(unit) => patch({ unit })}
              />
            </View>
          }
        />
      ) : null}
      {TIMED.includes(preset.freq) ? (
        <Row
          label={t("Time of day")}
          control={
            <NativeDatePicker
              label={t("Time of day")}
              value={clockDate(preset.time)}
              mode="time"
              onChange={(date) => patch({ time: formatClock(date.getHours(), date.getMinutes()) })}
            />
          }
        />
      ) : null}
      {preset.freq === "Advanced" ? (
        <View style={styles.cronRow}>
          <TextInput
            accessibilityLabel={t("Cron expression")}
            value={preset.cron}
            onChangeText={(cron) => patch({ cron })}
            placeholder="*/3 * * * *"
            placeholderTextColor={tokens.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={styles.cron}
          />
        </View>
      ) : null}
      {runAtLocal !== null ? (
        <Row
          label={t("Run at")}
          control={
            <NativeDatePicker
              label={t("Run at")}
              value={runAtLocal ? new Date(runAtLocal) : new Date()}
              mode="datetime"
              minimum={new Date()}
              onChange={(date) => onRunAt(toDatetimeLocalValue(date))}
            />
          }
        />
      ) : null}
    </Group>
  );
}

function NativeMenuPicker<V extends string | number>({
  label,
  selection,
  options,
  onChange,
}: {
  label: string;
  selection: V;
  options: Array<{ value: V; label: string }>;
  onChange: (value: V) => void;
}) {
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  return (
    <Host matchContents colorScheme={scheme}>
      <Picker
        label={label}
        selection={selection}
        onSelectionChange={(value) => onChange(value as V)}
        modifiers={[pickerStyle("menu"), labelsHidden(), tint(tokens.mutedForeground)]}
      >
        {options.map((option) => (
          <SwiftText key={String(option.value)} modifiers={[tag(option.value)]}>
            {option.label}
          </SwiftText>
        ))}
      </Picker>
    </Host>
  );
}

function NativeDatePicker({
  label,
  value,
  mode,
  minimum,
  onChange,
}: {
  /** Spoken by VoiceOver; the row already shows it. */
  label: string;
  value: Date;
  mode: "time" | "datetime";
  minimum?: Date;
  onChange: (date: Date) => void;
}) {
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  return (
    <Host matchContents colorScheme={scheme}>
      <DatePicker
        title={label}
        selection={value}
        displayedComponents={mode === "time" ? ["hourAndMinute"] : ["date", "hourAndMinute"]}
        range={minimum ? { start: minimum } : undefined}
        onDateChange={onChange}
        modifiers={[datePickerStyle("compact"), labelsHidden(), tint(tokens.foreground)]}
      />
    </Host>
  );
}

type InboundKind = "webhook" | "github";

/** A fixed length, so the dots do not tell how long the key is. */
const MASK = "•".repeat(16);

/** Where an inbound trigger posts and how it signs, with the bot's key hidden until asked. */
function InboundDetails({
  kind,
  botId,
  saved,
}: {
  kind: InboundKind;
  botId: string;
  /** A routine that is not saved yet offers no key rotation. */
  saved: boolean;
}) {
  const styles = useThemedStyles(createSheetStyles);
  const { t } = useI18n();
  const [key, setKey] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `${currentApiBase()}/api/v1/bots/${botId}`;
  const fail = (failure: unknown) => setError(serverMessage(failure) || t("Couldn't create"));

  // Read as the sheet opens, so the key shows before the routine is saved.
  useEffect(() => {
    let open = true;
    readWebhookKey(botId).then(
      (value) => open && setKey(value),
      (failure) => open && fail(failure),
    );
    return () => {
      open = false;
    };
  }, [botId]);

  const rotate = () =>
    Alert.alert(t("Rotate key?"), undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Rotate"),
        style: "destructive",
        onPress: () => {
          setRotating(true);
          setError(null);
          rotateWebhookKey(botId)
            .then((value) => {
              setKey(value);
              setShown(false);
            }, fail)
            .finally(() => setRotating(false));
        },
      },
    ]);

  const visible = (value: string) => (shown ? value : MASK);
  return (
    <View style={styles.details}>
      <Detail label={t("POST to")} value={`${base}/${kind}`} />
      {key ? (
        <>
          <Detail
            label={t("key")}
            value={key}
            display={visible(key)}
            reveal={{ shown, toggle: () => setShown((current) => !current) }}
          />
          {kind === "github" ? (
            <Detail label={t("header")} display="X-Hub-Signature-256: sha256=…" />
          ) : (
            <Detail
              label={t("header")}
              value={`Authorization: Bearer ${key}`}
              display={`Authorization: Bearer ${visible(key)}`}
            />
          )}
        </>
      ) : null}
      <SpokenError>{error}</SpokenError>
      {saved && (key || error) ? (
        <Pressable
          accessibilityRole="button"
          disabled={rotating}
          hitSlop={8}
          onPress={rotate}
          style={styles.rotate}
        >
          <Text style={[styles.rotateLabel, rotating && styles.dimmed]}>{t("Rotate key")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One labelled value; Copy takes `value` whatever `display` shows in its place. */
function Detail({
  label,
  value,
  display = value,
  reveal,
}: {
  label: string;
  value?: string;
  display?: string;
  reveal?: { shown: boolean; toggle: () => void };
}) {
  const styles = useThemedStyles(createSheetStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <View style={styles.detailBox}>
        <Text selectable={display === value} style={styles.detailValue}>
          {display}
        </Text>
        {reveal ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={reveal.shown ? t("Hide key") : t("Show key")}
            accessibilityState={{ selected: reveal.shown }}
            hitSlop={8}
            onPress={reveal.toggle}
          >
            <NativeSymbol
              ios={reveal.shown ? "eye.slash" : "eye"}
              android={reveal.shown ? "eye-off-outline" : "eye-outline"}
              size={17}
              color={tokens.mutedForeground}
            />
          </Pressable>
        ) : null}
        {value ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? t("Copied") : t("Copy {what}", { what: label })}
            hitSlop={8}
            onPress={() => {
              void Clipboard.setStringAsync(value).then(() => setCopied(true));
            }}
          >
            <NativeSymbol
              ios={copied ? "checkmark" : "doc.on.doc"}
              android={copied ? "checkmark" : "copy-outline"}
              size={16}
              color={tokens.mutedForeground}
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function createSheetStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: tokens.background },
    title: {
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 4,
      textAlign: "center",
      color: tokens.foreground,
      ...nativeTextStyle("composer", { weight: 600 }),
    },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 24,
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 36,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: tokens.border,
    },
    spacer: { flex: 1 },
    action: { minHeight: 44, justifyContent: "center" },
    actionLabel: { ...nativeTextStyle("composer") },
    destructive: { color: tokens.destructive },
    muted: { color: tokens.mutedForeground },
    primary: { color: tokens.foreground, fontWeight: "600" },
    dimmed: { opacity: 0.45 },
    body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40, gap: 24 },
    note: {
      paddingHorizontal: 16,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta", { size: 15 }),
    },
    pair: { flexDirection: "row", alignItems: "center", gap: 4 },
    cronRow: { paddingHorizontal: 16, paddingVertical: 12 },
    cron: {
      minHeight: 28,
      color: tokens.foreground,
      ...nativeTextStyle("mono", { size: 15 }),
    },
    details: { gap: 16 },
    detail: { gap: 6 },
    detailLabel: {
      color: tokens.mutedForeground,
      ...nativeTextStyle("label", { size: 13 }),
      letterSpacing: 0.4,
      textTransform: "uppercase",
      paddingHorizontal: 16,
    },
    detailBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: tokens.surface,
      borderRadius: radii.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: tokens.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    detailValue: {
      flex: 1,
      color: tokens.foreground,
      ...nativeTextStyle("mono", { size: 13 }),
    },
    rotate: { alignSelf: "flex-start", paddingHorizontal: 16 },
    rotateLabel: {
      color: tokens.foreground,
      ...nativeTextStyle("meta", { size: 15, weight: 500 }),
    },
  });
}
