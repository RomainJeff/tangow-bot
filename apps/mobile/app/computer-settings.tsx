import type { ComputerListItem, ComputerUpdateAllResult } from "@rakazo/contracts";
import { useState, useSyncExternalStore } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Group,
  LoadFailed,
  LoadingRows,
  QuietLine,
  Row,
  useFocusedRead,
} from "../components/bot-page/kit";
import { ComputerMaintenanceActions } from "../components/computer-maintenance-actions";
import { rpc } from "../lib/api";
import { computerUpdates } from "../lib/computer-updates";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

export default function ComputerSettings() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const { updates } = useSyncExternalStore(computerUpdates.subscribe, computerUpdates.getSnapshot);
  const activeUpdates = updates
    .filter((item) => item.status !== "failed" && item.status !== "completed")
    .map((item) => item.id)
    .join();
  const { read, write, retry } = useFocusedRead(
    () => rpc<ComputerListItem[]>("computer/list"),
    [activeUpdates],
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ComputerUpdateAllResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function statusLabel({ status }: ComputerListItem) {
    if (status.controlHolder === "user") return t("You have control");
    if (status.busyBotName) return t("{name} is using it", { name: status.busyBotName });
    switch (status.state) {
      case "booting":
        return t("Booting live desktop…");
      case "running":
        return t("Running");
      case "suspended":
        return t("Asleep");
      case "error":
        return t("Computer failed to boot");
      case "stopped":
        return t("Stopped");
    }
  }

  async function refresh() {
    const settle = write();
    const value = await rpc<ComputerListItem[]>("computer/list");
    settle(() => ({ kind: "ready", value }));
  }

  async function updateAll() {
    setPending(true);
    setResult(null);
    setError(null);
    try {
      const next = await rpc<ComputerUpdateAllResult>("computer/updateAll");
      setResult(next);
      await computerUpdates.refresh(next.queued);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not update computers"));
    } finally {
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        {read.kind === "loading" ? (
          <Group>
            <LoadingRows />
          </Group>
        ) : null}
        {read.kind === "failed" ? <LoadFailed onRetry={retry} /> : null}
        {read.kind === "ready" ? (
          read.value.length === 0 ? (
            <QuietLine>{t("No computers")}</QuietLine>
          ) : (
            <>
              {read.value.some((item) => item.status.updateAvailable) ? (
                <Group>
                  <Row
                    label={pending ? t("Updating…") : t("Update all computers")}
                    disabled={pending || !read.value.some((computer) => computer.status.canUpdate)}
                    onPress={() => void updateAll()}
                  />
                </Group>
              ) : null}
              {read.value.map((computer) => (
                <Group
                  key={computer.botId}
                  label={
                    computer.status.mode === "team" ? t("Team Computer") : t("Private Computer")
                  }
                >
                  <Row
                    label={t("Bots")}
                    subline={computer.bots.map((bot) => bot.name).join(", ")}
                    sublineLines={0}
                  />
                  <Row label={statusLabel(computer)} />
                  <ComputerMaintenanceActions
                    botId={computer.botId}
                    computer={computer.status}
                    disabled={pending}
                    onChanged={refresh}
                  />
                </Group>
              ))}
            </>
          )
        ) : null}
        {result ? (
          <Group>
            <Row label={t("Updates queued: {count}", { count: result.queued.length })} />
            {result.skipped.map((computer) => (
              <Row
                key={computer.botId}
                label={computer.name}
                subline={
                  computer.reason === "busy"
                    ? t("Busy. Try again when idle.")
                    : computer.reason === "unsupported"
                      ? t("Updates unavailable")
                      : t("Could not queue update. Try again.")
                }
                sublineLines={0}
                sublineTone={computer.reason === "failed" ? "destructive" : "muted"}
              />
            ))}
          </Group>
        ) : null}
        {error ? (
          <Group>
            <Row
              label={t("Could not update computers")}
              subline={error}
              sublineTone="destructive"
              sublineLines={0}
            />
          </Group>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 20 },
  });
}
