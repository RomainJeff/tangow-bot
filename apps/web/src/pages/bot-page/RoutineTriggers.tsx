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
import { Check, Clock, Copy, Eye, EyeOff, GitBranch, Globe, MessageSquare } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { RoutineSchedule } from "../RoutineSchedule";
import { type Confirm, SettingsGroup } from "./page-kit";
import { useRoutineCopy } from "./routine-copy";

/** How the trigger editor reaches the bot's webhook key; a routine not saved yet cannot rotate it. */
export type WebhookKey = {
  botId: string;
  read: () => Promise<string>;
  rotate?: () => Promise<string>;
};

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
  webhookKey,
  messageProviders,
  disabled,
  confirm,
  onSave,
}: {
  draft: RoutineDraft;
  existing: Routine | null;
  timezone: string;
  webhookKey: WebhookKey;
  messageProviders: string[];
  disabled?: boolean;
  confirm: Confirm;
  onSave: (next: RoutineDraft, armOneShot: boolean) => Promise<string | null>;
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
          webhookKey={webhookKey}
          confirm={confirm}
          onSave={onSave}
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
  webhookKey,
  confirm,
  onSave,
  onClose,
}: {
  initial: TriggerEdit;
  draft: RoutineDraft;
  existing: Routine | null;
  webhookKey: WebhookKey;
  confirm: Confirm;
  onSave: (next: RoutineDraft, armOneShot: boolean) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const copy = useRoutineCopy();
  const ids = useId();
  const [edit, setEdit] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
          <InboundDetails kind={inbound} webhookKey={webhookKey} confirm={confirm} />
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

/** A fixed length, so the dots do not tell how long the key is. */
const MASK = "•".repeat(16);

/** Where an inbound trigger posts and how it signs, with the bot's key hidden until asked. */
function InboundDetails({
  kind,
  webhookKey,
  confirm,
}: {
  kind: InboundKind;
  webhookKey: WebhookKey;
  confirm: Confirm;
}) {
  const { t } = useLingui();
  const [key, setKey] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fail = (failure: unknown) =>
    setError(failure instanceof Error && failure.message ? failure.message : t`Couldn't create`);

  // Read as the editor opens, so the key shows before the routine is saved.
  useEffect(() => {
    let open = true;
    webhookKey.read().then(
      (value) => open && setKey(value),
      (failure) => open && fail(failure),
    );
    return () => {
      open = false;
    };
  }, []);

  const rotate = async () => {
    if (!webhookKey.rotate || !(await confirm(t`Rotate key?`, t`Rotate`))) return;
    setRotating(true);
    setError(null);
    try {
      setKey(await webhookKey.rotate());
      setShown(false);
    } catch (failure) {
      fail(failure);
    } finally {
      setRotating(false);
    }
  };

  const post = `${window.location.origin}/api/v1/bots/${webhookKey.botId}/${kind}`;
  const visible = (value: string) => (shown ? value : MASK);
  const reveal = (
    <Button
      variant="roundIcon"
      size="roundIconSm"
      aria-label={shown ? t`Hide key` : t`Show key`}
      aria-pressed={shown}
      onClick={() => setShown((current) => !current)}
    >
      {shown ? <EyeOff /> : <Eye />}
    </Button>
  );
  return (
    <div className="flex flex-col gap-2.5 text-meta text-muted-foreground">
      <dl className="flex flex-col gap-2.5">
        <Detail label={t`POST to`} value={post} />
        {key ? (
          <>
            <Detail label={t`key`} value={key} display={visible(key)} reveal={reveal} />
            {kind === "github" ? (
              <Detail label={t`header`} display="X-Hub-Signature-256: sha256=…" />
            ) : (
              <Detail
                label={t`header`}
                value={`Authorization: Bearer ${key}`}
                display={`Authorization: Bearer ${visible(key)}`}
              />
            )}
          </>
        ) : null}
      </dl>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {(key || error) && webhookKey.rotate ? (
        <Button
          variant="tertiary"
          size="capsule"
          className="-ms-3 self-start"
          disabled={rotating}
          onClick={() => void rotate()}
        >
          {t`Rotate key`}
        </Button>
      ) : null}
    </div>
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
  reveal?: ReactNode;
}) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => undefined,
    );
  return (
    <div className="flex flex-col gap-1">
      <dt>{label}</dt>
      <dd className="flex items-start gap-0.5 rounded-row bg-muted ps-2.5 pe-0.5">
        <span className="min-w-0 flex-1 break-all py-1.5 font-mono text-mono text-foreground">
          {display}
        </span>
        {reveal}
        {value ? (
          <Button
            variant="roundIcon"
            size="roundIconSm"
            aria-label={t`Copy ${label}`}
            onClick={() => copy(value)}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        ) : null}
      </dd>
    </div>
  );
}
