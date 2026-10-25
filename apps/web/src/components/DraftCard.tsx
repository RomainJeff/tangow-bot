import { useLingui } from "@lingui/react/macro";
import type { AskDraft, AskDraftEdits } from "@rakazo/contracts";
import { ASK_DRAFT_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import type { DraftCard as DraftCardBlock, DraftLocal, RecipientRole } from "@rakazo/core";
import {
  addressesOf,
  changeLine,
  DRAFT_UNDO_MS,
  draftCardView,
  draftChanges,
  draftPrimaryAction,
  draftSentTo,
  foldedRoles,
  heldBack,
  RECIPIENT_ROLES,
} from "@rakazo/core";
import { Button, FramedBlock, Textarea, UserAvatar } from "@rakazo/ui-web";
import { Check, Copy, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { authClient } from "../lib/auth";
import { draftEdits } from "../lib/draft-edits";
import { messageTimeLabel } from "../lib/message-time";
import { userInitials } from "../lib/user-initials";
import type { CardEdits } from "./AskCard";
import { RecipientLine, SubjectLine } from "./DraftLines";

function AppLogo({ app }: { app: AskDraft["app"] }) {
  return app.logo ? (
    <img src={app.logo} alt="" className="size-5 shrink-0 rounded-chip object-contain" />
  ) : (
    <span
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center rounded-chip bg-well text-label text-foreground"
    >
      {app.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * The text with its sender in front of it: the mail leaves in the run owner's name. The viewer's own
 * photo when they own it; another member sees the owner's initials.
 */
function Sender({
  children,
  inWell,
  owner,
}: {
  children: ReactNode;
  inWell?: boolean;
  owner: AskDraft["owner"];
}) {
  const { t } = useLingui();
  const session = authClient.useSession();
  const user = session.data?.user;
  const own = !owner || owner.userId === user?.id;
  const name = own ? user?.name : owner.name;
  return (
    <div className="flex items-start gap-3">
      <UserAvatar
        initials={userInitials(name ?? t`You`)}
        image={own ? (user?.image ?? null) : null}
        className={inWell ? "mt-3 size-6 text-label" : "size-6 text-label"}
      />
      {children}
    </div>
  );
}

function StateMark({ tone, children }: { tone: "ink" | "destructive"; children: ReactNode }) {
  const color = tone === "destructive" ? "text-destructive" : "text-foreground";
  const dot = tone === "destructive" ? "bg-destructive" : "bg-foreground";
  return (
    <span className={`flex items-center gap-1.5 ${color}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

/**
 * A mail the bot wrote in the person's name, shown as it will leave: every recipient, the subject
 * and the text, which they edit in place before Send.
 */
export function DraftCard({
  block,
  canAnswer,
  viewerUserId,
  onAnswer,
  onReconnect,
  messageId,
}: {
  block: DraftCardBlock;
  canAnswer: boolean;
  viewerUserId?: string;
  onAnswer: (text: string, edits?: CardEdits) => Promise<void>;
  onReconnect?: () => void;
  /** The card's thread item: its edits are kept under it. */
  messageId: string;
}) {
  const { t, i18n } = useLingui();
  const { draft } = block;
  const [edit, setEdit] = useState<AskDraftEdits>(() => draftEdits.get(messageId) ?? {});
  const [focused, setFocused] = useState(false);
  // What each line's field holds, not yet an address: kept here so it outlives the line.
  const [typed, setTyped] = useState<Partial<Record<RecipientRole, string>>>({});
  // Cc and Bcc lines the person opened or changed: they stay shown even when empty.
  const [opened, setOpened] = useState<ReadonlySet<RecipientRole>>(new Set());
  const lineId = useId();
  const [pending, setPending] = useState<DraftLocal["pending"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnectOpened, setReconnectOpened] = useState(false);
  // Opening Reconnect answers one failure only: a send, or a card without a failure, starts over.
  if (reconnectOpened && !draft.failure) setReconnectOpened(false);
  const discardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitDiscardRef = useRef<() => void>(() => undefined);

  const text = edit.text ?? draft.body;
  const recipients = edit.recipients ?? draft.recipients;
  const changes = draftChanges(draft, edit);
  const edited = Object.keys(changes).length > 0;
  const owner = !draft.owner || draft.owner.userId === viewerUserId;
  const view = draftCardView(block, { edited, focused, pending, canAnswer, owner });
  const sendable =
    text.trim() !== "" &&
    recipients.some((recipient) => recipient.role === "to") &&
    !RECIPIENT_ROLES.some((role) => heldBack(typed[role] ?? ""));

  function keepEdit(next: AskDraftEdits) {
    const merged = { ...edit, ...next };
    setEdit(merged);
    draftEdits.set(messageId, merged);
  }

  function dropEdit() {
    setEdit({});
    draftEdits.delete(messageId);
  }

  function keepRole(role: RecipientRole, addresses: string[]) {
    keepEdit({ recipients: changeLine(recipients, opened, role, addresses).recipients });
    setOpened((current) => changeLine(recipients, current, role, addresses).opened);
  }

  function openLine(role: RecipientRole) {
    flushSync(() => setOpened((current) => new Set(current).add(role)));
    document.getElementById(`${lineId}-${role}`)?.focus();
  }

  async function send() {
    if (pending || !sendable) return;
    setReconnectOpened(false);
    setPending("send");
    setError(null);
    try {
      await onAnswer("allow", edited ? changes : undefined);
      dropEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not submit this answer`);
    } finally {
      setPending(null);
    }
  }

  async function commitDiscard() {
    discardTimer.current = null;
    setPending("discarding");
    try {
      await onAnswer("deny");
      dropEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not submit this answer`);
    } finally {
      setPending(null);
    }
  }
  commitDiscardRef.current = () => void commitDiscard();

  function discard() {
    if (pending) return;
    setError(null);
    setPending("discard");
    discardTimer.current = setTimeout(() => commitDiscardRef.current(), DRAFT_UNDO_MS);
  }

  function undo() {
    if (!discardTimer.current) return;
    clearTimeout(discardTimer.current);
    discardTimer.current = null;
    setPending(null);
  }

  // Leaving the thread inside the Undo window still discards: the person asked for it.
  useEffect(
    () => () => {
      if (!discardTimer.current) return;
      clearTimeout(discardTimer.current);
      commitDiscardRef.current();
    },
    [],
  );

  const app = draft.app.name;
  const header = {
    who: draft.app.account ? `${app} · ${draft.app.account}` : app,
    icon: <AppLogo app={draft.app} />,
  };
  if (view.kind === "sent") {
    const time = messageTimeLabel(view.at, i18n.locale);
    const recipient = draftSentTo(draft);
    return (
      <FramedBlock
        data-testid="draft-card"
        header={header}
        question={
          <Sender owner={draft.owner}>
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-normal">
              {draft.body}
            </p>
          </Sender>
        }
        answered={
          <span className="inline-flex items-center gap-1">
            <Check className="size-3.5 shrink-0" aria-hidden="true" />
            {t`Sent to ${recipient} · ${time}`}
          </span>
        }
      />
    );
  }

  if (view.kind !== "open") {
    let state: ReactNode;
    switch (view.kind) {
      case "discarded":
        state = view.undo ? (
          <>
            {t`Discarded`} ·{" "}
            <Button
              variant="link"
              onClick={undo}
              className="h-auto p-0 text-meta font-normal text-foreground underline decoration-border underline-offset-2 duration-(--duration-hover) ease-quiet hover:decoration-foreground"
            >
              {t`Undo`}
            </Button>
          </>
        ) : (
          t`Discarded`
        );
        break;
      case "replaced":
        state = t`Replaced`;
        break;
      case "inactive":
        state = t`No longer active`;
        break;
    }
    return (
      <FramedBlock
        data-testid="draft-card"
        answered={
          <span className="inline-flex items-center gap-2">
            <AppLogo app={draft.app} />
            <span>{state}</span>
          </span>
        }
      />
    );
  }

  const roleLabel = { to: t`To`, cc: t`Cc`, bcc: t`Bcc` };
  const marks = {
    not_sent: <StateMark tone="destructive">{t`Not sent`}</StateMark>,
    editing: <StateMark tone="ink">{t`Editing`}</StateMark>,
    edited: <StateMark tone="ink">{t`Edited`}</StateMark>,
  };
  const primary = draftPrimaryAction(view.failure, reconnectOpened);
  const reason = view.failure?.disconnected ? t`${app} is disconnected.` : view.failure?.reason;

  // Lines change only on a draft that records where its recipients and subject sit.
  const fields = view.readOnly || view.sending ? undefined : draft.fields;
  const subject = edit.subject ?? draft.subject ?? "";
  // An empty Cc or Bcc names nobody: it opens from the To line on demand.
  const hidden = foldedRoles(fields, recipients, typed, opened);

  return (
    <FramedBlock
      data-testid="draft-card"
      header={{ ...header, status: view.status ? marks[view.status] : undefined }}
      onFocus={(event) => setFocused(Boolean(event.target.closest("[data-draft-field]")))}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Element && next.closest("[data-draft-field]"))) setFocused(false);
      }}
      question={
        <div className="flex flex-col gap-1">
          {RECIPIENT_ROLES.map((role) => {
            const addresses = addressesOf(recipients, role);
            const room = fields?.[role];
            if (room !== undefined) {
              if (hidden.includes(role)) return null;
              return (
                <RecipientLine
                  key={role}
                  id={`${lineId}-${role}`}
                  label={roleLabel[role]}
                  addresses={addresses}
                  typed={typed[role] ?? ""}
                  room={room}
                  strong={role === "to"}
                  onChange={(next) => keepRole(role, next)}
                  onTyped={(next) => setTyped((current) => ({ ...current, [role]: next }))}
                  more={
                    role === "to"
                      ? hidden.map((each) => ({
                          label: roleLabel[each],
                          open: () => openLine(each),
                        }))
                      : undefined
                  }
                />
              );
            }
            if (!addresses.length) return null;
            return (
              <p
                key={role}
                className={role === "to" ? "break-words" : "break-words text-body font-normal"}
              >
                <span className="font-normal text-muted-foreground">{roleLabel[role]}</span>{" "}
                {addresses.join(", ")}
              </p>
            );
          })}
          {fields?.subject ? (
            <SubjectLine
              label={t`Subject`}
              subject={subject}
              onChange={(next) => keepEdit({ subject: next })}
            />
          ) : subject ? (
            <p className="break-words text-body font-normal">
              <span className="text-muted-foreground">{t`Subject`}</span> {subject}
            </p>
          ) : null}
        </div>
      }
      actions={
        view.readOnly ? undefined : (
          <>
            <Button
              variant="roundIconSecondary"
              size="roundIcon"
              aria-label={t`Discard`}
              disabled={view.sending}
              onClick={discard}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="roundIconSecondary"
              size="roundIcon"
              aria-label={t`Copy`}
              disabled={view.sending}
              onClick={() => void navigator.clipboard?.writeText(text).catch(() => undefined)}
            >
              <Copy className="size-4" aria-hidden="true" />
            </Button>
            {primary === "reconnect" ? (
              onReconnect ? (
                <Button
                  variant="capsule"
                  size="capsule"
                  onClick={() => {
                    setReconnectOpened(true);
                    onReconnect();
                  }}
                >
                  {t`Reconnect ${app}`}
                </Button>
              ) : null
            ) : (
              <Button
                variant="capsule"
                size="capsule"
                consequential
                disabled={view.sending || !sendable}
                onClick={() => void send()}
              >
                {view.sending ? t`Sending…` : primary === "try_again" ? t`Try again` : t`Send`}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-2">
        <Sender inWell owner={draft.owner}>
          {view.readOnly ? (
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-card bg-well px-4 py-3 text-body text-foreground">
              {draft.body}
            </p>
          ) : (
            <Textarea
              data-draft-field
              aria-label={t`Edit message`}
              dir="auto"
              value={text}
              readOnly={view.sending}
              maxLength={ASK_DRAFT_TEXT_MAX_LENGTH}
              onChange={(event) => keepEdit({ text: event.target.value })}
              className="min-h-0 w-auto min-w-0 flex-1 resize-none rounded-card border-0 bg-well px-4 py-3 text-body text-foreground duration-(--duration-hover) ease-quiet read-only:text-muted-foreground hover:ring-1 hover:ring-option-ring-hover focus-visible:ring-selected focus-visible:ring-foreground md:text-body dark:bg-well"
            />
          )}
        </Sender>
        {reason ? <p className="ps-9 text-meta text-muted-foreground">{reason}</p> : null}
        {error ? (
          <p role="alert" className="ps-9 text-meta text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </FramedBlock>
  );
}
