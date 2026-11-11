import type { ScratchpadItem, ScratchpadItemStatus } from "@tangow/contracts";
import { useState } from "react";
import { Alert, StyleSheet, TextInput } from "react-native";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../../lib/native";
import { serverMessage } from "../../lib/server-error";
import { nativeTextStyle } from "../../lib/typography";
import { Group, LoadFailed, LoadingRows, QuietLine, Row, useFocusedRead } from "./kit";

/**
 * The bot's open work: the server lists open and parked items, so a completed one leaves.
 * `epoch` changes when a run ends: the bot may have written to it.
 */
export function ScratchpadGroup({
  botId,
  readOnly,
  epoch,
  onAddFocus,
}: {
  botId: string;
  readOnly: boolean;
  epoch: number;
  /** The add field took focus: the page brings it above the keyboard. */
  onAddFocus: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createScratchpadStyles);
  const tokens = useMobileTokens();
  const { read, write, retry } = useFocusedRead(
    () => rpc<ScratchpadItem[]>("scratchpad/list", { botId }),
    [botId, epoch],
  );
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");

  const change = async (apply: () => Promise<(items: ScratchpadItem[]) => ScratchpadItem[]>) => {
    setBusy(true);
    const settle = write();
    try {
      const next = await apply();
      settle((current) =>
        current.kind === "ready" ? { kind: "ready", value: next(current.value) } : current,
      );
    } catch (error) {
      Alert.alert(serverMessage(error) || t("Could not save"));
    } finally {
      setBusy(false);
    }
  };

  /** Reads the submitted text, not `draft`, which can trail fast typing by a render. */
  const add = (text: string) => {
    const title = text.trim();
    if (!title || busy) return;
    // Cleared at once so the next item can be typed; given back if the save fails.
    setDraft("");
    void change(async () => {
      try {
        const created = await rpc<ScratchpadItem>("scratchpad/create", { botId, title });
        return (items) => [created, ...items.filter((item) => item.id !== created.id)];
      } catch (error) {
        setDraft((current) => current || title);
        throw error;
      }
    });
  };

  /** `null` removes the item. */
  const act = (item: ScratchpadItem, status: ScratchpadItemStatus | null) =>
    change(async () => {
      if (status === null) {
        await rpc("scratchpad/remove", { itemId: item.id });
        return (items) => items.filter((entry) => entry.id !== item.id);
      }
      const updated = await rpc<ScratchpadItem>("scratchpad/update", { itemId: item.id, status });
      return (items) =>
        items.flatMap((entry) =>
          entry.id !== item.id ? [entry] : updated.status === "done" ? [] : [updated],
        );
    });

  const menuFor = (item: ScratchpadItem) => ({
    title: item.title,
    actions: [
      { label: t("Complete"), onPress: () => void act(item, "done") },
      item.status === "parked"
        ? { label: t("Reopen"), onPress: () => void act(item, "open") }
        : { label: t("Park"), onPress: () => void act(item, "parked") },
      { label: t("Remove"), destructive: true, onPress: () => void act(item, null) },
    ],
  });

  const items = read.kind === "ready" ? read.value : [];
  return (
    <Group label={t("Open work")}>
      {read.kind === "loading" ? (
        <LoadingRows />
      ) : read.kind === "failed" ? (
        <LoadFailed onRetry={retry} />
      ) : readOnly && items.length === 0 ? (
        <QuietLine>{t("None yet")}</QuietLine>
      ) : null}
      {items.map((item) => (
        <Row
          key={item.id}
          label={item.title}
          subline={item.notes || null}
          sublineLines={2}
          value={item.status === "parked" ? t("Paused") : null}
          disabled={busy}
          menu={readOnly ? undefined : menuFor(item)}
        />
      ))}
      {read.kind === "ready" && !readOnly ? (
        <TextInput
          key="add"
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={t("Add item")}
          placeholderTextColor={tokens.mutedForeground}
          accessibilityLabel={t("Add item")}
          maxLength={200}
          returnKeyType="done"
          submitBehavior="submit"
          onFocus={onAddFocus}
          onSubmitEditing={(event) => add(event.nativeEvent.text)}
        />
      ) : null}
    </Group>
  );
}

function createScratchpadStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    input: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 12,
      color: tokens.foreground,
      ...nativeTextStyle("composer"),
    },
  });
}
