import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { draftFromRoutine, saveKey, triggerSave } from "@rakazo/core";
import {
  Button,
  type FieldSave,
  SaveMeta,
  SettingRow,
  Switch,
  TextSettingField,
  useFieldSave,
} from "@rakazo/ui-web";
import { useState } from "react";
import { DeleteItemDialog } from "../shell/dialogs";
import { type BotPageContext, type Confirm, SettingsGroup, useSaveLabels } from "./page-kit";
import { useRoutineActive } from "./RoutinesTab";
import { WhenToRun, webhookInfo } from "./RoutineTriggers";
import { useRoutineCopy } from "./routine-copy";

type RoutineField = "name" | "prompt" | "notify" | "requireToolApproval";

function useRoutineField<F extends RoutineField>(
  { bot, userId, commands }: BotPageContext,
  routine: Routine,
  field: F,
): FieldSave<Routine[F]> {
  return useFieldSave<Routine[F]>({
    key: saveKey({ userId, spaceId: bot.spaceId }, bot.id, `routine:${routine.id}:${field}`),
    serverValue: routine[field],
    commit: async (value) => {
      await commands.updateRoutine(bot.id, routine.id, { [field]: value });
    },
  });
}

/**
 * One routine, edited in the wide panel. Each field saves on its own: text when
 * it is left, switches when flipped, a trigger when its editor is done.
 */
export function RoutineDetail({
  page,
  routine,
  messageProviders,
  webhookSecret,
  onWebhookSecret,
  confirm,
  onDeleted,
}: {
  page: BotPageContext;
  routine: Routine;
  messageProviders: string[];
  webhookSecret: string | null;
  onWebhookSecret: (secret: string) => void;
  confirm: Confirm;
  onDeleted: () => void;
}) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const copy = useRoutineCopy();
  const { bot, commands } = page;
  const name = useRoutineField(page, routine, "name");
  const prompt = useRoutineField(page, routine, "prompt");
  const notify = useRoutineField(page, routine, "notify");
  const approval = useRoutineField(page, routine, "requireToolApproval");
  const active = useRoutineActive(page, routine);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const draft = draftFromRoutine(routine, () => new Date());
  const inbound =
    routine.webhookEnabled || routine.githubEnabled || Boolean(routine.messageProvider);
  const webhook = webhookInfo(bot.id, webhookSecret, bot.webhookConfigured);

  const reveal = async () => onWebhookSecret(await commands.revealWebhookSecret(bot.id));

  const saveTriggers = async (next: typeof draft): Promise<string | null> => {
    const checked = triggerSave(routine, next, () => new Date());
    if (!checked.ok) return copy.draftError(checked.error);
    const { patch } = checked;
    if (Object.keys(patch).length === 0) return null;
    try {
      if (checked.needsWebhookKey && !webhook.configured) await reveal();
      await commands.updateRoutine(bot.id, routine.id, patch);
      return null;
    } catch (error) {
      return error instanceof Error && error.message ? error.message : t`Could not save`;
    }
  };

  const testRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await commands.testRun(bot.id, routine.id);
    } catch (error) {
      setRunError(
        error instanceof Error && error.message ? error.message : t`Could not run routine`,
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div data-testid="routine-detail" className="flex flex-col gap-6 px-4 pt-1 pb-4">
      <div className="flex flex-col gap-1 px-3.5">
        <div className="flex items-center gap-3">
          <TextSettingField
            label={<span className="sr-only">{t`Name`}</span>}
            field={name}
            labels={labels}
            meta={false}
            required
            maxLength={80}
            dir="auto"
            className="min-w-0 flex-1 gap-0"
            controlClassName="h-auto border-transparent bg-transparent px-0 py-0.5 text-title text-foreground md:text-title dark:bg-transparent"
          />
          <SaveMeta
            state={name.state.kind === "idle" ? active.state : name.state}
            labels={labels}
            onRetry={name.state.kind === "idle" ? active.retry : name.retry}
          />
          <Switch
            aria-label={t`Active`}
            checked={active.value}
            onCheckedChange={(checked) => void active.save(checked)}
          />
        </div>
        <p className="text-row-status text-muted-foreground">
          {copy.cadenceLine({ ...routine, active: active.value })}
        </p>
      </div>

      <TextSettingField
        label={t`Instruction`}
        field={prompt}
        labels={labels}
        multiline
        rows={4}
        required
        keepDraft
        placeholder={t`What should this routine do each time it runs?`}
        dir="auto"
        className="gap-1.5"
        labelClassName="mx-3.5"
        controlClassName="min-h-18 rounded-card border-transparent bg-background px-4 py-3 text-row-name dark:bg-background"
      />

      <WhenToRun
        draft={draft}
        existing={routine}
        timezone={routine.timezone}
        webhook={webhook}
        messageProviders={messageProviders}
        confirm={confirm}
        onSave={saveTriggers}
        onRotate={() => void reveal().catch(() => undefined)}
      />

      <SettingsGroup>
        {inbound ? (
          <SettingRow
            label={t`Ask before every action`}
            meta={<SaveMeta state={approval.state} labels={labels} onRetry={approval.retry} />}
          >
            <Switch
              aria-label={t`Ask before every action`}
              data-testid="routine-tool-approval-switch"
              checked={approval.value}
              onCheckedChange={(checked) => void approval.save(checked)}
            />
          </SettingRow>
        ) : null}
        <SettingRow
          label={t`Notify me`}
          meta={<SaveMeta state={notify.state} labels={labels} onRetry={notify.retry} />}
        >
          <Switch
            aria-label={t`Notify me`}
            data-testid="routine-notify-switch"
            checked={notify.value}
            onCheckedChange={(checked) => void notify.save(checked)}
          />
        </SettingRow>
      </SettingsGroup>

      {runError ? (
        <p role="alert" className="mx-3.5 text-meta text-destructive">
          {runError}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button variant="tertiary" size="capsule" disabled={running} onClick={() => void testRun()}>
          {running ? t`Running…` : t`Test run`}
        </Button>
        <Button
          variant="tertiary"
          size="capsule"
          className="text-destructive hover:text-destructive"
          onClick={() => setDeleting(true)}
        >
          {t`Delete routine`}
        </Button>
      </div>
      {deleting ? (
        <DeleteItemDialog
          item={routine}
          noun="routine"
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await commands.removeRoutine(bot.id, routine.id);
            onDeleted();
          }}
        />
      ) : null}
    </div>
  );
}
