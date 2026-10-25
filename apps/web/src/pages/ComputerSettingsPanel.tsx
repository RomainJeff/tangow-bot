import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerListItem, ComputerUpdateAllResult } from "@rakazo/contracts";
import { Button, SettingRow } from "@rakazo/ui-web";
import { useEffect, useState, useSyncExternalStore } from "react";
import { LoadingState } from "../components/ai/primitives";
import { ComputerMaintenanceActions } from "../components/ComputerMaintenanceActions";
import { computerUpdates } from "../lib/computer-updates";
import { rpc } from "../lib/rpc";

export function ComputerSettingsPanel() {
  const { t } = useLingui();
  const [computers, setComputers] = useState<ComputerListItem[] | null>(null);
  const [error, setError] = useState<"load" | "update" | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ComputerUpdateAllResult | null>(null);
  const { updates } = useSyncExternalStore(computerUpdates.subscribe, computerUpdates.getSnapshot);
  const activeUpdates = updates
    .filter((item) => item.status !== "failed" && item.status !== "completed")
    .map((item) => item.id)
    .join();

  async function refresh() {
    setError(null);
    try {
      setComputers(await rpc.computer.list());
    } catch {
      setError("load");
    }
  }

  useEffect(() => {
    void refresh();
  }, [activeUpdates]);

  async function updateAll() {
    setPending(true);
    setError(null);
    setResult(null);
    try {
      setResult(await rpc.computer.updateAll());
      await computerUpdates.refresh();
      await refresh();
    } catch {
      setError("update");
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="computer-settings" className="flex flex-col gap-4">
      <Button
        className="self-start"
        disabled={pending || !computers?.some((item) => item.status.canUpdate)}
        onClick={() => void updateAll()}
      >
        {pending ? <Trans>Updating…</Trans> : <Trans>Update all computers</Trans>}
      </Button>
      {result ? (
        <div role="status" className="text-meta text-muted-foreground">
          <p>{t`Updates queued: ${result.queued.length}`}</p>
          {result.skipped.map((item) => (
            <p key={item.botId}>
              {item.name}
              {" · "}
              {item.reason === "busy"
                ? t`Busy. Try again when idle.`
                : item.reason === "unsupported"
                  ? t`Updates are unavailable on this device`
                  : t`Could not update computer`}
            </p>
          ))}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex items-center gap-2 text-meta text-destructive">
          {error === "load" ? (
            <Trans>Could not load computers</Trans>
          ) : (
            <Trans>Could not update computers</Trans>
          )}
          <Button variant="link" onClick={() => void refresh()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {!computers && !error ? <LoadingState /> : null}
      {computers?.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          <Trans>No computers</Trans>
        </p>
      ) : null}
      {computers?.length ? (
        <div className="overflow-hidden rounded-card bg-group shadow-group">
          {computers.map((item) => (
            <section
              key={item.botId}
              className="flex flex-col gap-3 border-b border-border px-3.5 py-3 last:border-b-0"
              data-testid="computer-settings-row"
            >
              <SettingRow
                label={item.status.mode === "team" ? t`Team Computer` : t`Private Computer`}
                subline={t`Bots: ${item.bots.map((bot) => bot.name).join(", ")}`}
                className="p-0"
              />
              {item.status.controlHolder === "user" ? (
                <p className="text-meta text-muted-foreground">
                  <Trans>You have control</Trans>
                </p>
              ) : item.status.busyBotName ? (
                <p className="text-meta text-muted-foreground">{t`${item.status.busyBotName} is using it`}</p>
              ) : null}
              <ComputerMaintenanceActions
                botId={item.botId}
                computer={item.status}
                onChanged={refresh}
                disabled={pending}
              />
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
