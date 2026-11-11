import type { ComputerStatus } from "@tangow/contracts";
import { useState, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { rpc } from "../lib/api";
import { computerUpdates } from "../lib/computer-updates";
import { useI18n } from "../lib/i18n";
import { Row, Separated } from "./bot-page/kit";

type Action = "recover" | "reset" | "update";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
  disabled = false,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const { updates } = useSyncExternalStore(computerUpdates.subscribe, computerUpdates.getSnapshot);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!computer) return null;

  const busy =
    disabled ||
    Boolean(computer.busyBotName) ||
    computer.state === "booting" ||
    computer.controlHolder === "user" ||
    updates.some(
      (update) =>
        update.botId === botId && update.status !== "completed" && update.status !== "failed",
    );

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await computerUpdates.start(botId, "recover");
      else if (action === "reset") await rpc("computer/reset", { botId });
      else await computerUpdates.start(botId);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not update computer"));
    } finally {
      setPending(null);
    }
  }

  function confirmReset() {
    Alert.alert(
      t("Reset computer?"),
      t("Restore the last saved workspace. Unsaved work on the computer is lost."),
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Reset"), style: "destructive", onPress: () => void run("reset") },
      ],
    );
  }

  return (
    <Separated>
      {computer.updateAvailable ? <Row label={t("Update available")} /> : null}
      <Row
        label={pending === "recover" ? t("Recovering…") : t("Recover computer")}
        disabled={busy || pending !== null}
        onPress={() => void run("recover")}
      />
      <Row
        label={pending === "reset" ? t("Resetting…") : t("Reset computer")}
        disabled={busy || pending !== null}
        onPress={confirmReset}
      />
      {computer.canUpdate ? (
        <Row
          label={pending === "update" ? t("Updating…") : t("Update computer")}
          disabled={busy || pending !== null}
          onPress={() => void run("update")}
        />
      ) : null}
      {error ? (
        <Row
          label={t("Could not update computer")}
          subline={error}
          sublineTone="destructive"
          sublineLines={0}
        />
      ) : null}
    </Separated>
  );
}
