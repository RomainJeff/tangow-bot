import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { emptyRoutineDraft, type RoutineDraft, validateRoutineDraft } from "@rakazo/core";
import { Button, Input, Label, SettingRow, Switch, Textarea } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { localTimezone } from "../../lib/local-timezone";
import type { RoutineSeed } from "../shell/layout";
import { type BotPageContext, type Confirm, SettingsGroup } from "./page-kit";
import { WhenToRun } from "./RoutineTriggers";
import { useRoutineCopy } from "./routine-copy";

/**
 * A new routine. Unlike the rest of the page it is a form with one Create
 * button: without a trigger a routine does not exist yet, so nothing saves
 * until it is whole.
 */
export function RoutineCreateForm({
  page,
  seed,
  messageProviders,
  confirm,
  onCreated,
}: {
  page: BotPageContext;
  seed: RoutineSeed | undefined;
  messageProviders: string[];
  confirm: Confirm;
  onCreated: (routine: Routine) => void;
}) {
  const { t } = useLingui();
  const copy = useRoutineCopy();
  const ids = useId();
  const { bot, commands } = page;
  const [draft, setDraft] = useState<RoutineDraft>(() => ({ ...emptyRoutineDraft(), ...seed }));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const webhookKey = { botId: bot.id, read: () => commands.webhookSecret(bot.id) };
  const inbound = draft.webhookEnabled || draft.githubEnabled || Boolean(draft.messageProvider);
  const patch = (partial: Partial<RoutineDraft>) =>
    setDraft((current) => ({ ...current, ...partial }));

  const create = async () => {
    const checked = validateRoutineDraft(draft, null, () => new Date(), {
      name: t`Routine`,
      prompt: t`Check in.`,
    });
    if (!checked.ok) {
      setError(copy.draftError(checked.error));
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const needsKey = (draft.webhookEnabled || draft.githubEnabled) && !bot.webhookConfigured;
      if (needsKey) await webhookKey.read();
      onCreated(await commands.createRoutine(bot.id, checked.payload));
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message ? failure.message : t`Could not save routine`,
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div data-testid="routine-create" className="flex flex-col gap-6 px-4 pt-1 pb-4">
      <h2 className="px-3.5 text-title text-foreground">{t`New routine`}</h2>
      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor={`${ids}-name`}
          className="mx-3.5 text-label font-normal text-muted-foreground"
        >
          {t`Name`}
        </Label>
        <Input
          id={`${ids}-name`}
          value={draft.name}
          maxLength={80}
          placeholder={t`Name this routine`}
          dir="auto"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor={`${ids}-prompt`}
          className="mx-3.5 text-label font-normal text-muted-foreground"
        >
          {t`Instruction`}
        </Label>
        <Textarea
          id={`${ids}-prompt`}
          value={draft.prompt}
          rows={4}
          placeholder={t`What should this routine do each time it runs?`}
          dir="auto"
          onChange={(event) => patch({ prompt: event.target.value })}
        />
      </div>
      <WhenToRun
        draft={draft}
        existing={null}
        timezone={localTimezone()}
        webhookKey={webhookKey}
        messageProviders={messageProviders}
        disabled={creating}
        confirm={confirm}
        onSave={async (next) => {
          setDraft(next);
          setError(null);
          return null;
        }}
      />
      <SettingsGroup>
        <SettingRow label={t`Active`}>
          <Switch
            aria-label={t`Active`}
            checked={draft.active}
            onCheckedChange={(active) => patch({ active })}
          />
        </SettingRow>
        {inbound ? (
          <SettingRow label={t`Ask before every action`}>
            <Switch
              aria-label={t`Ask before every action`}
              data-testid="routine-tool-approval-switch"
              checked={draft.requireToolApproval}
              onCheckedChange={(requireToolApproval) => patch({ requireToolApproval })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label={t`Notify me`}>
          <Switch
            aria-label={t`Notify me`}
            data-testid="routine-notify-switch"
            checked={draft.notify}
            onCheckedChange={(notify) => patch({ notify })}
          />
        </SettingRow>
      </SettingsGroup>
      {error ? (
        <p role="alert" className="mx-3.5 text-meta text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button variant="capsule" size="capsule" disabled={creating} onClick={() => void create()}>
          {t`Create`}
        </Button>
      </div>
    </div>
  );
}
