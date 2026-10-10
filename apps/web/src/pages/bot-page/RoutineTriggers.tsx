import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import {
  applyTriggerEdit,
  CRON_FREQS,
  type CronFreq,
  cronFromPreset,
  newScheduleEdit,
  type RoutineDraft,
  removeTriggerEffect,
  routineTriggers,
  type TriggerEdit,
  triggerEditArmsOneShot,
  triggerEditFor,
  triggerEditRef,
  withoutTrigger,
} from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Label,
  SettingRow,
} from "@rakazo/ui-web";
import { Clock, GitBranch, Globe, MessageSquare } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { RoutineSchedule } from "../RoutineSchedule";
import { type Confirm, SettingsGroup } from "./page-kit";
import { useRoutineCopy } from "./routine-copy";

/** Where a bot's inbound triggers post, and its key when it was minted this session. */
type WebhookInfo = {
  path: string;
  githubPath: string;
  /** Shown once: the server never returns it again. */
  secret: string | null;
  configured: boolean;
};

export function webhookInfo(botId: string, secret: string | null, configured: boolean) {
  const origin = window.location.origin;
  return {
    path: `${origin}/api/v1/bots/${botId}/webhook`,
    githubPath: `${origin}/api/v1/bots/${botId}/github`,
    secret,
    configured: configured || secret !== null,
  } satisfies WebhookInfo;
}

/**
 * "When to run": one row per trigger, each opening its editor, and the menu that
 * adds one. `onSave` receives the whole draft with the change, and whether the
 * editor asked when a one-shot runs, and answers with an error to show in the
 * editor, or null once it is applied.
 */
export function WhenToRun({
  draft,
  existing,
  timezone,
  webhook,
  messageProviders,
  disabled,
  confirm,
  onSave,
  onReveal,
  onRotate,
}: {
  draft: RoutineDraft;
  existing: Routine | null;
  timezone: string;
  webhook: WebhookInfo;
  messageProviders: string[];
  disabled?: boolean;
  confirm: Confirm;
  onSave: (next: RoutineDraft, armOneShot: boolean) => Promise<string | null>;
  /** Mints the bot's key if it has none. */
  onReveal: () => Promise<void>;
  /** Replaces the bot's key; a routine that is not saved yet offers no rotation. */
  onRotate?: () => Promise<void>;
}) {
  const { t } = useLingui();
  const copy = useRoutineCopy();
  const [edit, setEdit] = useState<TriggerEdit | null>(null);
  const triggers = routineTriggers(draft);
  const presetLabels: Record<CronFreq, string> = {
    "Every hour": t`Every hour`,
    "Every day": t`Every day`,
    Weekdays: t`Weekdays`,
    "Every week": t`Every week`,
    "Every month": t`Every month`,
    Interval: t`Interval`,
    Advanced: t`Advanced...`,
  };

  return (
    <section className="flex flex-col gap-1.5">
      <div className="mx-3.5 flex items-baseline justify-between gap-3">
        <h2 className="text-label text-muted-foreground">{t`When to run`}</h2>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            render={<Button variant="tertiary" size="capsule" className="-me-3" />}
          >
            {t`Add trigger`}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Clock />
                {t`On a schedule`}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-40">
                {CRON_FREQS.map((freq) => (
                  <DropdownMenuItem
                    key={freq}
                    onClick={() => setEdit(newScheduleEdit(draft, freq))}
                  >
                    {presetLabels[freq]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {(["slack", "teams"] as const).map((provider) => (
              <DropdownMenuItem
                key={provider}
                disabled={Boolean(draft.messageProvider) || !messageProviders.includes(provider)}
                onClick={() => setEdit({ kind: "message", provider, adding: true })}
              >
                <MessageSquare />
                {copy.messageLabel(provider)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              disabled={draft.githubEnabled}
              onClick={() => setEdit({ kind: "github", adding: true })}
            >
              <GitBranch />
              {t`Git event`}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={draft.webhookEnabled}
              onClick={() => setEdit({ kind: "webhook", adding: true })}
            >
              <Globe />
              {t`Webhook`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {triggers.length > 0 ? (
        <SettingsGroup>
          {triggers.map((trigger) => {
            const preset = trigger.kind === "schedule" ? draft.schedules[trigger.index] : null;
            return (
              <SettingRow
                key={trigger.kind === "schedule" ? `schedule-${trigger.index}` : trigger.kind}
                label={copy.triggerLabel(draft, trigger)}
                subline={
                  preset ? `${copy.scheduleLabel(cronFromPreset(preset))} · ${timezone}` : undefined
                }
                chevron
                disabled={disabled}
                onClick={() => setEdit(triggerEditFor(draft, trigger))}
              />
            );
          })}
        </SettingsGroup>
      ) : null}
      {edit ? (
        <TriggerDialog
          key={edit.kind === "schedule" ? `schedule-${edit.index}` : edit.kind}
          initial={edit}
          draft={draft}
          existing={existing}
          webhook={webhook}
          confirm={confirm}
          onSave={onSave}
          onReveal={onReveal}
          onRotate={onRotate}
          onClose={() => setEdit(null)}
        />
      ) : null}
    </section>
  );
}

function TriggerDialog({
  initial,
  draft,
  existing,
  webhook,
  confirm,
  onSave,
  onReveal,
  onRotate,
  onClose,
}: {
  initial: TriggerEdit;
  draft: RoutineDraft;
  existing: Routine | null;
  webhook: WebhookInfo;
  confirm: Confirm;
  onSave: (next: RoutineDraft, armOneShot: boolean) => Promise<string | null>;
  onReveal: () => Promise<void>;
  onRotate?: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const copy = useRoutineCopy();
  const ids = useId();
  const [edit, setEdit] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const ref = triggerEditRef(edit);
  const next = applyTriggerEdit(draft, edit);
  const armOneShot = triggerEditArmsOneShot(draft, edit, existing);
  const inbound = edit.kind === "webhook" || edit.kind === "github" ? edit.kind : null;
  const title =
    edit.kind === "schedule"
      ? t`On a schedule`
      : edit.kind === "message"
        ? copy.messageLabel(edit.provider)
        : edit.kind === "github"
          ? t`Git event`
          : t`When a webhook fires`;

  // The key is minted here, as the editor opens, so it shows before the routine is saved.
  const reveal = async (request: () => Promise<void>) => {
    setRevealing(true);
    setError(null);
    try {
      await request();
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t`Couldn't create`);
    } finally {
      setRevealing(false);
    }
  };
  useEffect(() => {
    if (inbound !== null && !webhook.configured) void reveal(onReveal);
  }, []);

  const save = async (value: RoutineDraft, arm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const failure = await onSave(value, arm);
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
      setError(copy.draftError({ code: "no_trigger" }));
      return;
    }
    const question =
      ref.kind === "webhook"
        ? t`Remove webhook?`
        : ref.kind === "github"
          ? t`Remove Git event?`
          : t`Remove message trigger?`;
    if (effect === "confirm" && !(await confirm(question, t`Remove`))) return;
    await save(withoutTrigger(draft, ref), false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="gap-4 sm:max-w-md">
        <DialogTitle>{title}</DialogTitle>
        {edit.kind === "schedule" ? (
          <>
            <RoutineSchedule
              value={edit.preset}
              onChange={(preset) => setEdit({ ...edit, preset })}
            />
            {armOneShot ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${ids}-run-at`} className="text-meta text-muted-foreground">
                  {t`Run at`}
                </Label>
                <Input
                  id={`${ids}-run-at`}
                  type="datetime-local"
                  value={edit.runAtLocal}
                  onChange={(event) => setEdit({ ...edit, runAtLocal: event.target.value })}
                />
              </div>
            ) : null}
          </>
        ) : edit.kind === "message" ? (
          <p className="text-meta text-muted-foreground">
            {t`Runs when this bot receives a verified message from this provider.`}
          </p>
        ) : inbound ? (
          <InboundDetails
            kind={inbound}
            webhook={webhook}
            revealing={revealing}
            onRotate={onRotate ? () => void reveal(onRotate) : undefined}
          />
        ) : null}
        {error ? (
          <p role="alert" className="text-meta text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          {ref ? (
            <Button
              variant="tertiary"
              size="capsule"
              className="-ms-3 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              {t`Remove`}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button variant="capsuleSecondary" size="capsule" disabled={busy} onClick={onClose}>
            {t`Cancel`}
          </Button>
          <Button
            variant="capsule"
            size="capsule"
            disabled={busy}
            onClick={() => void save(next, armOneShot)}
          >
            {t`Done`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type InboundKind = "webhook" | "github";

/** Where an inbound trigger posts and how it signs. The key shows once, then only after a rotation. */
function InboundDetails({
  kind,
  webhook,
  revealing,
  onRotate,
}: {
  kind: InboundKind;
  webhook: WebhookInfo;
  revealing: boolean;
  onRotate?: () => void;
}) {
  const { t } = useLingui();
  const { secret, configured } = webhook;
  const post = kind === "github" ? webhook.githubPath : webhook.path;
  const key = secret ?? (configured ? t`Saved. Rotate to reveal.` : null);
  const header =
    kind === "github"
      ? "X-Hub-Signature-256: sha256=…"
      : secret
        ? `Authorization: Bearer ${secret}`
        : configured
          ? "Authorization: Bearer …"
          : null;
  const cell = "break-all rounded-row bg-muted px-2.5 py-1.5 font-mono text-mono text-foreground";
  return (
    <dl className="flex flex-col gap-2.5 text-meta text-muted-foreground">
      <div className="flex flex-col gap-1">
        <dt>{t`POST to`}</dt>
        <dd className={cell}>{post}</dd>
      </div>
      {key ? (
        <div className="flex flex-col gap-1">
          <dt>{t`key`}</dt>
          <dd className={cell}>{key}</dd>
          {secret ? <dd>{t`Shown once.`}</dd> : null}
        </div>
      ) : null}
      {header ? (
        <div className="flex flex-col gap-1">
          <dt>{t`header`}</dt>
          <dd className={cell}>{header}</dd>
        </div>
      ) : null}
      {configured && !secret && onRotate ? (
        <Button
          variant="tertiary"
          size="capsule"
          className="-ms-3 self-start"
          disabled={revealing}
          onClick={onRotate}
        >
          {t`Rotate key`}
        </Button>
      ) : null}
    </dl>
  );
}
