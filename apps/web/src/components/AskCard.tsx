import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH, SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import {
  askFormOf,
  askSettledOf,
  canEditSpawnBotCard,
  isApprovalAskBlock,
  isSecretAskBlock,
  routineCardSettlement,
  spawnBotEdits,
  spawnBotReadOnlyDetail,
  storedAnswerOf,
} from "@rakazo/core";
import type { FramedBlockActionsAlign } from "@rakazo/ui-web";
import { Button, FramedBlock, Input, Surface, Textarea } from "@rakazo/ui-web";
import { ChevronRight, Repeat } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Fragment, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { approvalActionLabel } from "../lib/approval-labels";
import { AskSettled } from "./ask/AskSettled";

const DETAIL_CLASS =
  "max-h-72 overflow-auto rounded-card bg-muted px-3.5 py-3 font-mono text-mono whitespace-pre-wrap break-words text-muted-foreground";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;
export type SpawnBotCardEdits = NonNullable<ReturnType<typeof spawnBotEdits>>;

/** The field a server refusal is about, from its text; both when it cannot be told. */
function invalidBotFields(error: string | null): { name: boolean; instructions: boolean } {
  const name = /^(name\b|A bot named)/.test(error ?? "");
  const instructions = /^instructions\b/.test(error ?? "");
  const unknown = error !== null && !name && !instructions;
  return { name: name || unknown, instructions: instructions || unknown };
}

function formatAnsweredState(
  answer: string | undefined,
  secret: boolean,
  outcome?: "created" | "cancelled",
): string {
  if (secret) return t`Saved`;
  if (!answer) return t`Answered`;
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

/** What became of a routine card: a link to the routine, or why there is none. */
function RoutineSettled({ block, botId }: { block: AskBlock; botId?: string }) {
  if (!block.created || !botId) {
    switch (routineCardSettlement(block)) {
      case "failed":
        return t`Couldn't create`;
      case "not_now":
        return t`Not now`;
      case "creating":
        return t`Creating…`;
      default:
        return t`Answered`;
    }
  }
  return (
    <Link
      to={{
        pathname: `/app/${botId}`,
        search: `?routine=${encodeURIComponent(block.created.id)}`,
      }}
      className="inline-flex items-center gap-1 duration-(--duration-hover) ease-quiet hover:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {block.confirms === "updated" ? t`Routine updated` : t`Routine created`} ·{" "}
      <span className="font-medium text-foreground">{block.created.label}</span>
      <ChevronRight className="size-3 shrink-0" aria-hidden />
    </Link>
  );
}

/** What a routine card creates, as plain text: the name, when it runs, what it does. */
function RoutinePreview({ routine }: { routine: NonNullable<AskBlock["routine"]> }) {
  return (
    <Surface data-testid="routine-preview" className="flex flex-col gap-1 px-3.5 py-3">
      <span className="flex items-center gap-1.5 text-label text-foreground">
        <Repeat className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">{routine.name}</span>
      </span>
      <span className="text-meta text-muted-foreground">{routine.schedule}</span>
      <p className="mt-1 whitespace-pre-wrap break-words text-meta text-foreground">
        {routine.prompt}
      </p>
      {routine.notify ? (
        <span className="mt-1 text-meta text-muted-foreground">{t`Notifies you each run`}</span>
      ) : null}
    </Surface>
  );
}

function approvalActionVariant(id: string): "capsule" | "capsuleSecondary" | "tertiary" {
  if (id === "allow") return "capsule";
  if (id === "always") return "capsuleSecondary";
  return "tertiary";
}

// Left to right: dismiss, Edit, the secondary approval, the primary one.
const EDIT_RANK = 1;
function approvalActionRank(id: string): number {
  if (id === "allow") return 3;
  if (id === "always") return 2;
  return 0;
}

function secretFieldLabel(purpose: AskBlock["purpose"]): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
}

/** The row of answer capsules shared by approvals, plain asks and the multi-question stepper. */
function OptionsRow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div data-testid="ask-options" className={`flex flex-wrap gap-2 ${className ?? ""}`.trim()}>
      {children}
    </div>
  );
}

/** A free-text field styled with tokens, optionally submitting on Enter. */
function AnswerInput({
  className,
  onSubmit,
  ...props
}: Omit<ComponentProps<typeof Input>, "onKeyDown"> & { onSubmit?: () => void }) {
  return (
    <Input
      className={`rounded-card border-outline bg-surface text-body ${className ?? ""}`.trim()}
      onKeyDown={
        onSubmit
          ? (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onSubmit();
              }
            }
          : undefined
      }
      {...props}
    />
  );
}

export function AskCard({
  block,
  canAnswer,
  viewerUserId,
  onAnswer,
  messageId,
  botId,
}: {
  block: AskBlock;
  canAnswer: boolean;
  /** Only the run's owner may edit a Create bot card. */
  viewerUserId?: string;
  onAnswer: (text: string, edits?: SpawnBotCardEdits) => Promise<void>;
  messageId: string;
  /** The bot that posted the card, whose page a routine card links to. */
  botId?: string;
}) {
  const { t } = useLingui();
  const fieldId = useId();
  const [editing, setEditing] = useState(false);
  // Keyed by message: a card that changes (another thread, another ask) drops the edit.
  const [botDraft, setBotDraft] = useState<{
    messageId: string;
    name: string;
    instructions: string;
  } | null>(null);
  const [answer, setAnswer] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const approval = isApprovalAskBlock(block);
  const approvalActions = approval ? block.actions : undefined;
  const askActions = block.actions;
  const secretInput = isSecretAskBlock(block);
  const secretLabel = secretFieldLabel(block.purpose);

  async function submitAnswer(value: string, edits?: SpawnBotCardEdits) {
    if (submitting) return;
    if (secretInput ? value.length === 0 : !value.trim()) return;
    const submitValue = secretInput ? value : value.trim();
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    if (secretInput) setAnswer("");
    try {
      await (edits ? onAnswer(submitValue, edits) : onAnswer(submitValue));
    } catch (err) {
      setError(
        !secretInput && err instanceof Error ? err.message : t`Could not submit this answer`,
      );
    } finally {
      setPendingAction(null);
    }
  }

  const form = askFormOf(block);
  if (form && (block.status === "answered" || !canAnswer)) {
    const stored = block.status === "answered" ? storedAnswerOf(form, block) : null;
    return <AskSettled view={askSettledOf(form, stored)} className="mt-1.5" />;
  }
  if (block.questions?.length) {
    return <MultiQuestionAsk block={block} onAnswer={onAnswer} messageId={messageId} />;
  }

  // A routine card, proposed by the bot or confirming one set up, shows what it creates instead
  // of the plain-text detail.
  const routineCard = approval ? block.routine : undefined;
  // The row above already names the bot; the card only repeats itself for a consequential
  // approval, name-less. A plain question or a routine card opens with no header.
  const header = approval && !routineCard ? { who: t`Needs your call` } : undefined;
  const consequence = routineCard ? undefined : secretInput ? (
    block.credential?.origin ? (
      <span className="break-all">{block.credential.origin}</span>
    ) : undefined
  ) : block.detail ? (
    <pre className={DETAIL_CLASS}>{block.detail}</pre>
  ) : undefined;

  const answered: ReactNode =
    block.status === "answered" ? (
      routineCard ? (
        <RoutineSettled block={block} botId={botId} />
      ) : (
        formatAnsweredState(
          block.answer,
          secretInput,
          approvalActions?.find((action) => action.id === block.answer)?.outcome,
        )
      )
    ) : !canAnswer ? (
      t`No longer active`
    ) : undefined;

  let children: ReactNode = null;
  let actions: ReactNode = null;
  let actionsAlign: FramedBlockActionsAlign = "end";

  // Only a pending spawn_bot card that carries its fields can be edited, and only by the run's
  // owner. A card from an older server has no `spawnBot`: it stays read-only, approve or cancel.
  const spawnBot =
    approval &&
    answered === undefined &&
    block.spawnBot &&
    canEditSpawnBotCard(block.spawnBot, viewerUserId)
      ? block.spawnBot
      : undefined;
  const draft = botDraft?.messageId === messageId ? botDraft : null;
  const botEditing = spawnBot !== undefined && draft !== null;

  if (answered === undefined) {
    if (approvalActions?.length) {
      const submitApproval = (id: string) => {
        // While editing, Cancel leaves the edit; the card's own Cancel refuses the bot.
        if (id === "deny" && botEditing) {
          setBotDraft(null);
          setError(null);
          return;
        }
        if (id === "allow" && spawnBot && draft) {
          const edits = spawnBotEdits(spawnBot, draft);
          return void submitAnswer("allow", edits);
        }
        return void submitAnswer(id);
      };
      const ranked = approvalActions.map((action) => ({
        key: action.id,
        rank: approvalActionRank(action.id),
        node: (
          <Button
            variant={approvalActionVariant(action.id)}
            size="capsule"
            consequential={action.id === "allow" && !routineCard}
            disabled={submitting || (action.id === "allow" && botEditing && !draft?.name.trim())}
            onClick={() => submitApproval(action.id)}
          >
            {pendingAction === action.id ? <Trans>Sending…</Trans> : approvalActionLabel(action)}
          </Button>
        ),
      }));
      if (spawnBot && !botEditing) {
        ranked.push({
          key: "edit",
          rank: EDIT_RANK,
          node: (
            <Button
              variant="tertiary"
              size="capsule"
              disabled={submitting}
              onClick={() =>
                setBotDraft({
                  messageId,
                  name: spawnBot.name,
                  instructions: spawnBot.instructions,
                })
              }
            >
              <Trans>Edit</Trans>
            </Button>
          ),
        });
      }
      actions = ranked
        .sort((a, b) => a.rank - b.rank)
        .map(({ key, node }) => <Fragment key={key}>{node}</Fragment>);
      if (routineCard) children = <RoutinePreview routine={routineCard} />;
      if (spawnBot && draft) {
        const readOnly = spawnBotReadOnlyDetail(spawnBot);
        const invalid = invalidBotFields(error);
        children = (
          <div className="flex flex-col gap-2.5">
            <div>
              <label
                htmlFor={`${fieldId}-name`}
                className="mb-1.5 block text-meta text-muted-foreground"
              >
                <Trans>Name</Trans>
              </label>
              <Input
                id={`${fieldId}-name`}
                autoFocus
                autoComplete="off"
                maxLength={BOT_NAME_MAX_LENGTH}
                disabled={submitting}
                aria-invalid={invalid.name ? true : undefined}
                value={draft.name}
                onChange={(event) => setBotDraft({ ...draft, name: event.target.value })}
              />
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-instructions`}
                className="mb-1.5 block text-meta text-muted-foreground"
              >
                <Trans>Instructions</Trans>
              </label>
              <Textarea
                id={`${fieldId}-instructions`}
                className="max-h-72 overflow-auto"
                maxLength={SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH}
                disabled={submitting}
                aria-invalid={invalid.instructions ? true : undefined}
                value={draft.instructions}
                onChange={(event) => setBotDraft({ ...draft, instructions: event.target.value })}
              />
            </div>
            {readOnly ? <pre className={DETAIL_CLASS}>{readOnly}</pre> : null}
            {error ? (
              <p role="alert" className="text-meta text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        );
      }
    } else if (secretInput) {
      children = (
        <AnswerInput
          aria-label={secretLabel}
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={submitting}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onSubmit={() => void submitAnswer(answer)}
          placeholder={secretLabel}
        />
      );
      actions = (
        <Button
          variant="capsule"
          size="capsule"
          disabled={answer.length === 0 || submitting}
          onClick={() => void submitAnswer(answer)}
        >
          {submitting ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
      );
    } else if (askActions?.length) {
      // "Other answer…" belongs to the list of answers; sending a typed one is a decision.
      if (!editing) actionsAlign = "start";
      children = (
        <>
          <OptionsRow>
            {askActions.map((action) => (
              <Button
                key={action.id}
                type="button"
                variant={pendingAction === action.id ? "capsule" : "quickReply"}
                size="quickReply"
                aria-pressed={pendingAction === action.id}
                disabled={submitting}
                onClick={() => void submitAnswer(action.id)}
              >
                {pendingAction === action.id ? <Trans>Sending…</Trans> : action.label}
              </Button>
            ))}
          </OptionsRow>
          {editing ? (
            <AnswerInput
              className="mt-2.5"
              aria-label={t`Other answer`}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onSubmit={() => void submitAnswer(answer)}
              placeholder={t`Type a different answer`}
              autoFocus
              disabled={submitting}
            />
          ) : null}
        </>
      );
      actions = editing ? (
        <>
          <Button
            type="button"
            variant="tertiary"
            size="capsule"
            disabled={submitting}
            onClick={() => {
              setAnswer("");
              setEditing(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="button"
            variant="capsule"
            size="capsule"
            disabled={!answer.trim() || submitting}
            onClick={() => void submitAnswer(answer)}
          >
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="tertiary"
          size="capsule"
          disabled={submitting}
          onClick={() => setEditing(true)}
        >
          <Trans>Other answer…</Trans>
        </Button>
      );
    } else {
      children = editing ? (
        <AnswerInput
          aria-label={t`Answer`}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onSubmit={() => void submitAnswer(answer)}
          placeholder={t`Type your answer`}
          autoFocus
          disabled={submitting}
        />
      ) : null;
      actions = editing ? (
        <>
          <Button
            type="button"
            variant="tertiary"
            size="capsule"
            disabled={submitting}
            onClick={() => {
              setAnswer("");
              setEditing(false);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="button"
            variant="capsule"
            size="capsule"
            disabled={!answer.trim() || submitting}
            onClick={() => void submitAnswer(answer)}
          >
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
          </Button>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="tertiary"
            size="capsule"
            disabled={submitting}
            onClick={() => setEditing(true)}
          >
            <Trans>Edit first</Trans>
          </Button>
          <Button
            type="button"
            variant="capsule"
            size="capsule"
            disabled={submitting}
            onClick={() => void submitAnswer("approved")}
          >
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send it</Trans>}
          </Button>
        </>
      );
    }
  }

  return (
    <FramedBlock
      className="mt-1.5"
      data-testid={secretInput ? "secret-ask-card" : undefined}
      header={header ? { ...header, dot: answered === undefined } : undefined}
      // An approval question can carry model-written text (a bot's name): never fetch an image for it.
      question={
        routineCard ? (
          block.text
        ) : (
          <ChatMarkdown allowImages={!approval}>
            {botEditing ? t`Create bot?` : block.text}
          </ChatMarkdown>
        )
      }
      consequence={botEditing ? undefined : consequence}
      answered={answered}
      actions={actions}
      actionsAlign={actionsAlign}
    >
      {children}
      {error && !botEditing ? (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      ) : null}
    </FramedBlock>
  );
}

type AskQuestionBlock = NonNullable<AskBlock["questions"]>[number];
type LocalAnswer = { selected: string[]; other: string; otherOpen: boolean; skipped: boolean };
type AskDraft = { answers: Record<string, LocalAnswer>; index: number };

// In-progress multi-question answers survive the card unmounting (switching threads and back)
// keyed by the ask message id, until the card is submitted.
const askDrafts = new Map<string, AskDraft>();

function isAnswered(a: LocalAnswer): boolean {
  return a.selected.length > 0 || a.other.trim().length > 0;
}

/** An open card of questions; answered or no longer waiting, it is an AskSettled. */
function MultiQuestionAsk({
  block,
  onAnswer,
  messageId,
}: {
  block: AskBlock;
  onAnswer: (text: string) => Promise<void>;
  messageId: string;
}) {
  const { t } = useLingui();
  const questions = (block.questions ?? []) as AskQuestionBlock[];
  const [index, setIndex] = useState(() => askDrafts.get(messageId)?.index ?? 0);
  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>(
    () => askDrafts.get(messageId)?.answers ?? {},
  );
  useEffect(() => {
    askDrafts.set(messageId, { answers, index });
  }, [messageId, answers, index]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = questions.length;
  const current = questions[index]!;
  const isLast = index === total - 1;
  const get = (id: string): LocalAnswer =>
    answers[id] ?? { selected: [], other: "", otherOpen: false, skipped: false };

  function update(id: string, patch: Partial<LocalAnswer>) {
    setAnswers((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] ?? { selected: [], other: "", otherOpen: false, skipped: false }),
        ...patch,
      },
    }));
  }

  function toggleOption(question: AskQuestionBlock, optionId: string) {
    const state = get(question.id);
    if (question.multiSelect) {
      const selected = state.selected.includes(optionId)
        ? state.selected.filter((id) => id !== optionId)
        : [...state.selected, optionId];
      update(question.id, { selected, skipped: false });
    } else {
      const selected = state.selected[0] === optionId ? [] : [optionId];
      // Single choice: tapping an option replaces any typed free-text answer, so only one
      // of the two ever reaches the server.
      update(question.id, { selected, other: "", skipped: false });
    }
  }

  const requiredSatisfied = questions.every((question) => {
    if (question.required === false) return true;
    return isAnswered(get(question.id));
  });

  async function submit() {
    if (submitting || !requiredSatisfied) return;
    const payload: Record<string, { selected?: string[]; other?: string; skipped?: boolean }> = {};
    for (const question of questions) {
      const state = get(question.id);
      const answeredQuestion = isAnswered(state);
      const other = state.other.trim();
      if (answeredQuestion) {
        payload[question.id] = {
          ...(state.selected.length ? { selected: state.selected } : {}),
          ...(other ? { other } : {}),
        };
      } else {
        payload[question.id] = { skipped: true };
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(JSON.stringify({ answers: payload }));
      askDrafts.delete(messageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not submit these answers`);
    } finally {
      setSubmitting(false);
    }
  }

  const progressRow = (
    <div className="flex items-center gap-2.5">
      <div className="flex gap-1.5">
        {questions.map((question, dotIndex) => {
          const done = isAnswered(get(question.id));
          const active = dotIndex === index;
          return (
            <button
              key={question.id}
              type="button"
              onClick={() => setIndex(dotIndex)}
              aria-label={question.header || question.question}
              className={`h-1.5 rounded-full transition-all ${
                active
                  ? "w-6 bg-foreground"
                  : done
                    ? "w-1.5 bg-success"
                    : "w-1.5 bg-muted-foreground/40"
              }`}
            />
          );
        })}
      </div>
      <span className="text-label text-muted-foreground">
        {index + 1}/{total}
      </span>
    </div>
  );

  const showOtherField =
    !current.options?.length || !current.multiSelect || get(current.id).otherOpen;

  return (
    <FramedBlock
      className="mt-1.5"
      question={current.question}
      actions={
        <>
          {index > 0 ? (
            <Button
              type="button"
              variant="tertiary"
              size="capsule"
              disabled={submitting}
              onClick={() => setIndex(index - 1)}
            >
              <Trans>Back</Trans>
            </Button>
          ) : null}
          {current.required === false ? (
            <Button
              type="button"
              variant="tertiary"
              size="capsule"
              disabled={submitting}
              onClick={() => {
                update(current.id, { selected: [], other: "", skipped: true });
                if (!isLast) setIndex(index + 1);
              }}
            >
              <Trans>Skip</Trans>
            </Button>
          ) : null}
          {isLast ? (
            <Button
              type="button"
              variant="capsule"
              size="capsule"
              disabled={submitting || !requiredSatisfied}
              onClick={() => void submit()}
            >
              {submitting ? <Trans>Sending…</Trans> : <Trans>Send answers</Trans>}
            </Button>
          ) : (
            <Button
              type="button"
              variant="capsule"
              size="capsule"
              disabled={submitting}
              onClick={() => setIndex(index + 1)}
            >
              <Trans>Next</Trans>
            </Button>
          )}
        </>
      }
    >
      {progressRow}
      <OptionsRow className="mt-3">
        {current.options?.map((option) => {
          const selected = get(current.id).selected.includes(option.id);
          return (
            <Button
              key={option.id}
              type="button"
              variant={selected ? "capsule" : "quickReply"}
              size="quickReply"
              aria-pressed={selected}
              disabled={submitting}
              onClick={() => toggleOption(current, option.id)}
            >
              {option.label}
            </Button>
          );
        })}
        {current.options?.length && current.multiSelect ? (
          <Button
            type="button"
            variant={get(current.id).otherOpen ? "capsule" : "quickReply"}
            size="quickReply"
            aria-pressed={get(current.id).otherOpen}
            disabled={submitting}
            onClick={() => {
              const open = !get(current.id).otherOpen;
              update(current.id, {
                otherOpen: open,
                ...(open ? {} : { other: "" }),
                skipped: false,
              });
            }}
          >
            <Trans>Other…</Trans>
          </Button>
        ) : null}
      </OptionsRow>
      {/* Single-select and free-text questions type inline; multi-select reveals the field
              only when the "Other" checkbox is on. */}
      {showOtherField ? (
        <div className="mt-2.5">
          <AnswerInput
            aria-label={t`Other answer`}
            value={get(current.id).other}
            autoFocus={current.multiSelect && get(current.id).otherOpen}
            onChange={(event) => {
              const other = event.target.value;
              update(current.id, {
                other,
                ...(current.multiSelect || !other.trim() ? {} : { selected: [] }),
                skipped: false,
              });
            }}
            placeholder={current.options?.length ? t`Type a different answer` : t`Type your answer`}
            disabled={submitting}
          />
        </div>
      ) : null}
      {error ? <p className="mt-2 text-meta text-destructive">{error}</p> : null}
    </FramedBlock>
  );
}
