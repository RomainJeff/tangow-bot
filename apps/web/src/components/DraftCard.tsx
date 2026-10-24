import { useLingui } from "@lingui/react/macro";
import type { AskDraft } from "@rakazo/contracts";
import { ASK_DRAFT_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import { Button, FramedBlock, UserAvatar } from "@rakazo/ui-web";
import { Check, Copy, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../lib/auth";
import { draftEdits } from "../lib/draft-edits";
import { messageTimeLabel } from "../lib/message-time";
import { userInitials } from "../lib/user-initials";
import type { CardEdits } from "./AskCard";
import type { DraftCard as DraftCardBlock, DraftCardView } from "./draft-card-view";
import { draftCardView } from "./draft-card-view";

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

/** The text with the person in front of it: the mail leaves in their name. */
function Sender({ children, inWell }: { children: ReactNode; inWell?: boolean }) {
  const { t } = useLingui();
  const session = authClient.useSession();
  const user = session.data?.user;
  return (
    <div className="flex items-start gap-3">
      <UserAvatar
        initials={userInitials(user?.name ?? t`You`)}
        image={user?.image ?? null}
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
  onAnswer,
  messageId,
}: {
  block: DraftCardBlock;
  canAnswer: boolean;
  onAnswer: (text: string, edits?: CardEdits) => Promise<void>;
  /** The card's thread item: its edits are kept under it. */
  messageId: string;
}) {
  const { t, i18n } = useLingui();
  const { draft } = block;
  const [edit, setEdit] = useState(() => draftEdits.get(messageId) ?? null);
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState<"send" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const discardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitDiscardRef = useRef<() => void>(() => undefined);

  const text = edit ?? draft.body;
  const edited = text !== draft.body;
  const view: DraftCardView = draftCardView(block, { edited, focused, pending, canAnswer });

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
    if (discardTimer.current) clearTimeout(discardTimer.current);
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
  const toLine = (
    <span className="break-words">
      <span className="font-normal text-muted-foreground">{t`To`}</span> {to}
    </span>
  );

  if (view.kind !== "open") {
    let answered: ReactNode;
    let question: ReactNode = toLine;
    switch (view.kind) {
      case "sent": {
        const time = messageTimeLabel(view.at, i18n.locale);
        const recipient = to || draft.recipients.map((each) => each.address).join(", ");
        question = (
          <Sender>
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-normal">
              {draft.body}
            </p>
          </Sender>
        );
        answered = (
          <span className="inline-flex items-center gap-1">
            <Check className="size-3.5 shrink-0" aria-hidden="true" />
            {t`Sent to ${recipient} · ${time}`}
          </span>
        );
        break;
      }
      case "discarded":
        answered = view.undo ? (
          <>
            {t`Discarded`} ·{" "}
            <button
              type="button"
              onClick={undo}
              className="text-foreground underline decoration-border underline-offset-2 duration-(--duration-hover) ease-quiet hover:decoration-foreground"
            >
              {t`Undo`}
            </button>
          </>
        ) : (
          t`Discarded`
        );
        break;
      case "replaced":
        answered = t`Replaced`;
        break;
      case "inactive":
        answered = t`No longer active`;
        break;
    }
    return (
      <FramedBlock
        data-testid="draft-card"
        header={header}
        question={question}
        answered={answered}
      />
    );
  }

  const roleLabel = { to: t`To`, cc: t`Cc`, bcc: t`Bcc` };
  const marks = {
    not_sent: <StateMark tone="destructive">{t`Not sent`}</StateMark>,
    editing: <StateMark tone="ink">{t`Editing`}</StateMark>,
    edited: <StateMark tone="ink">{t`Edited`}</StateMark>,
  };
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
          <Button
            variant="capsule"
            size="capsule"
            consequential
            disabled={view.sending || !text.trim()}
            onClick={() => void send()}
          >
            {view.sending ? t`Sending…` : view.failure ? t`Try again` : t`Send`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Sender inWell>
          <textarea
            aria-label={t`Edit message`}
            dir="auto"
            value={text}
            readOnly={view.sending}
            maxLength={ASK_DRAFT_TEXT_MAX_LENGTH}
            onChange={(event) => keepEdit(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            className="field-sizing-content min-w-0 flex-1 resize-none rounded-card bg-well px-4 py-3 text-body text-foreground outline-none duration-(--duration-hover) ease-quiet read-only:text-muted-foreground hover:ring-1 hover:ring-option-ring-hover focus-visible:ring-selected focus-visible:ring-foreground"
          />
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
