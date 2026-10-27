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
import { BotActivity } from "./BotActivity";
import { type BotPageContext, type Confirm, SettingsGroup, useSaveLabels } from "./page-kit";
import { useRoutineActive } from "./RoutinesTab";
import { WhenToRun } from "./RoutineTriggers";
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
  confirm,
  onDeleted,
}: {
  page: BotPageContext;
  routine: Routine;
  messageProviders: string[];
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
  // The shell reads activity again when a run ends; a test run should show as soon as it starts.
  const [testRuns, setTestRuns] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const draft = draftFromRoutine(routine, () => new Date());
  const inbound =
    routine.webhookEnabled || routine.githubEnabled || Boolean(routine.messageProvider);
  const webhookKey = {
    botId: bot.id,
    read: () => commands.webhookSecret(bot.id),
    rotate: () => commands.rotateWebhookSecret(bot.id),
  };

  const saveTriggers = async (next: typeof draft, armOneShot: boolean): Promise<string | null> => {
    const checked = triggerSave(routine, next, () => new Date(), armOneShot);
    if (!checked.ok) return copy.draftError(checked.error);
    const { patch } = checked;
    if (Object.keys(patch).length === 0) return null;
    try {
      if (checked.needsWebhookKey && !bot.webhookConfigured) await webhookKey.read();
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
      setTestRuns((count) => count + 1);
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
        controlClassName="min-h-18 rounded-card border-transparent bg-group px-4 py-3 text-row-name shadow-group dark:bg-group"
      />

      <WhenToRun
        draft={draft}
        existing={routine}
        timezone={routine.timezone}
        webhookKey={webhookKey}
        messageProviders={messageProviders}
        confirm={confirm}
        onSave={saveTriggers}
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

      <section className="flex flex-col gap-1.5">
        <div className="mx-3.5 flex items-baseline justify-between gap-3">
          <h2 className="text-label text-muted-foreground">{t`Activity`}</h2>
          <Button
            variant="tertiary"
            size="capsule"
            className="-me-3"
            disabled={running}
            onClick={() => void testRun()}
          >
            {running ? t`Running…` : t`Test run`}
          </Button>
        </div>
        {runError ? (
          <p role="alert" className="mx-3.5 text-meta text-destructive">
            {runError}
          </p>
        ) : null}
        <BotActivity
          botId={bot.id}
          routineId={routine.id}
          commands={{
            activityEpoch: commands.activityEpoch + testRuns,
            openRun: commands.openRun,
            viewRun: commands.viewRun,
          }}
        />
      </section>

      <div className="flex justify-end">
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
