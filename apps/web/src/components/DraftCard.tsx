import { useLingui } from "@lingui/react/macro";
import type { AskDraft } from "@rakazo/contracts";
import { ASK_DRAFT_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import { Button, FramedBlock, Textarea, UserAvatar } from "@rakazo/ui-web";
import { Check, Copy, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../lib/auth";
import { draftEdits } from "../lib/draft-edits";
import { messageTimeLabel } from "../lib/message-time";
import { userInitials } from "../lib/user-initials";
import type { CardEdits } from "./AskCard";
import type { DraftCard as DraftCardBlock, DraftLocal } from "./draft-card-view";
import { draftCardView, draftPrimaryAction } from "./draft-card-view";

/** How long a discarded draft can still be brought back before the bot hears of it. */
const UNDO_MS = 5000;

const ROLES = ["to", "cc", "bcc"] as const;

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

/** Every address of one role, in the order the bot gave them. */
function addressesOf(draft: AskDraft, role: (typeof ROLES)[number]): string {
  return draft.recipients
    .filter((recipient) => recipient.role === role)
    .map((recipient) => recipient.address)
    .join(", ");
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
  const [edit, setEdit] = useState(() => draftEdits.get(messageId) ?? null);
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState<DraftLocal["pending"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnectOpened, setReconnectOpened] = useState(false);
  // Opening Reconnect answers one failure only: a send, or a card without a failure, starts over.
  if (reconnectOpened && !draft.failure) setReconnectOpened(false);
  const discardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitDiscardRef = useRef<() => void>(() => undefined);

  const text = edit ?? draft.body;
  const edited = text !== draft.body;
  const owner = !draft.owner || draft.owner.userId === viewerUserId;
  const view = draftCardView(block, { edited, focused, pending, canAnswer, owner });

  function keepEdit(next: string) {
    setEdit(next);
    draftEdits.set(messageId, next);
  }

  function dropEdit() {
    setEdit(null);
    draftEdits.delete(messageId);
  }

  async function send() {
    if (pending || !text.trim()) return;
    setReconnectOpened(false);
    setPending("send");
    setError(null);
    try {
      await onAnswer("allow", edited ? { text } : undefined);
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
    discardTimer.current = setTimeout(() => commitDiscardRef.current(), UNDO_MS);
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
  const to = addressesOf(draft, "to");

  if (view.kind === "sent") {
    const time = messageTimeLabel(view.at, i18n.locale);
    const recipient = to || draft.recipients.map((each) => each.address).join(", ");
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

  return (
    <FramedBlock
      data-testid="draft-card"
      header={{ ...header, status: view.status ? marks[view.status] : undefined }}
      question={
        <div className="flex flex-col gap-1">
          {ROLES.map((role) => {
            const addresses = addressesOf(draft, role);
            if (!addresses) return null;
            return (
              <p
                key={role}
                className={role === "to" ? "break-words" : "break-words text-body font-normal"}
              >
                <span className="font-normal text-muted-foreground">{roleLabel[role]}</span>{" "}
                {addresses}
              </p>
            );
          })}
          {draft.subject ? (
            <p className="break-words text-body font-normal">
              <span className="text-muted-foreground">{t`Subject`}</span> {draft.subject}
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
                disabled={view.sending || !text.trim()}
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
              aria-label={t`Edit message`}
              dir="auto"
              value={text}
              readOnly={view.sending}
              maxLength={ASK_DRAFT_TEXT_MAX_LENGTH}
              onChange={(event) => keepEdit(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
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
