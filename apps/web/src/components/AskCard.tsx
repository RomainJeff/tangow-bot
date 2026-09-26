import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock, selectedAskActionLabel } from "@rakazo/core";
import { Button, FramedBlock, Input } from "@rakazo/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useState } from "react";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function formatAnsweredState(
  answer: string | undefined,
  approval: boolean,
  secret: boolean,
  outcome?: "created" | "cancelled",
  actions?: AskBlock["actions"],
): string {
  if (secret) return t`Saved`;
  if (!answer) return t`Answered`;
  if (!approval) return t`Answered: ${selectedAskActionLabel(answer, actions)}`;
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

function approvalActionLabel(
  id: string,
  fallback: string,
  outcome?: "created" | "cancelled",
): string {
  if (outcome === "created") return t`Create space`;
  if (outcome === "cancelled") return t`Cancel`;
  if (id === "allow") return t`Allow once`;
  if (id === "always") return t`Always allow this tool`;
  if (id === "deny") return t`Deny`;
  return fallback;
}

function approvalActionVariant(id: string): "capsule" | "capsuleSecondary" | "tertiary" {
  if (id === "allow") return "capsule";
  if (id === "always") return "capsuleSecondary";
  return "tertiary";
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

/** A footer split between a leading group (Back/Skip/Cancel/Other) and a trailing primary action. */
function FooterRow({ leading, trailing }: { leading?: ReactNode; trailing: ReactNode }) {
  return (
    <div className="flex w-full items-center justify-between">
      <div className="flex gap-2">{leading}</div>
      {trailing}
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
  onAnswer,
  messageId,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (text: string) => Promise<void>;
  messageId: string;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const approval = isApprovalAskBlock(block);
  const approvalActions = approval ? block.actions : undefined;
  const askActions = block.actions;
  const secretInput = isSecretAskBlock(block);
  const secretLabel = secretFieldLabel(block.purpose);

  async function submitAnswer(value: string) {
    if (submitting) return;
    if (secretInput ? value.length === 0 : !value.trim()) return;
    const submitValue = secretInput ? value : value.trim();
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    if (secretInput) setAnswer("");
    try {
      await onAnswer(submitValue);
    } catch (err) {
      setError(
        !secretInput && err instanceof Error ? err.message : t`Could not submit this answer`,
      );
    } finally {
      setPendingAction(null);
    }
  }

  if (block.questions?.length) {
    return (
      <MultiQuestionAsk
        block={block}
        canAnswer={canAnswer}
        onAnswer={onAnswer}
        messageId={messageId}
      />
    );
  }

  // The row above already names the bot; the card only repeats itself for a
  // consequential approval, name-less. A plain question opens with no header.
  const header = approval ? { who: t`Needs your call` } : undefined;
  const consequence = secretInput ? (
    block.credential?.origin ? (
      <span className="break-all">{block.credential.origin}</span>
    ) : undefined
  ) : block.detail ? (
    <pre className="max-h-72 overflow-auto rounded-card bg-muted px-3.5 py-3 font-mono text-mono whitespace-pre-wrap break-words text-muted-foreground">
      {block.detail}
    </pre>
  ) : undefined;

  const answered =
    block.status === "answered"
      ? formatAnsweredState(
          block.answer,
          Boolean(approvalActions),
          secretInput,
          approvalActions?.find((action) => action.id === block.answer)?.outcome,
          askActions,
        )
      : !canAnswer
        ? t`No longer active`
        : undefined;

  let children: ReactNode = null;
  let actions: ReactNode = null;

  if (answered === undefined) {
    if (approvalActions?.length) {
      actions = (
        <OptionsRow>
          {approvalActions.map((action) => (
            <Button
              key={action.id}
              variant={approvalActionVariant(action.id)}
              size="capsule"
              consequential={action.id === "allow"}
              disabled={submitting}
              onClick={() => void submitAnswer(action.id)}
            >
              {pendingAction === action.id ? (
                <Trans>Sending…</Trans>
              ) : (
                approvalActionLabel(action.id, action.label, action.outcome)
              )}
            </Button>
          ))}
        </OptionsRow>
      );
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
        <FooterRow
          leading={
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
          }
          trailing={
            <Button
              type="button"
              variant="capsule"
              size="capsule"
              disabled={!answer.trim() || submitting}
              onClick={() => void submitAnswer(answer)}
            >
              {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
            </Button>
          }
        />
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
        <FooterRow
          leading={
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
          }
          trailing={
            <Button
              type="button"
              variant="capsule"
              size="capsule"
              disabled={!answer.trim() || submitting}
              onClick={() => void submitAnswer(answer)}
            >
              {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
            </Button>
          }
        />
      ) : (
        <FooterRow
          leading={
            <Button
              type="button"
              variant="tertiary"
              size="capsule"
              disabled={submitting}
              onClick={() => setEditing(true)}
            >
              <Trans>Edit first</Trans>
            </Button>
          }
          trailing={
            <Button
              type="button"
              variant="capsule"
              size="capsule"
              disabled={submitting}
              onClick={() => void submitAnswer("approved")}
            >
              {submitting ? <Trans>Sending…</Trans> : <Trans>Send it</Trans>}
            </Button>
          }
        />
      );
    }
  }

  return (
    <FramedBlock
      className="mt-1.5"
      data-testid={secretInput ? "secret-ask-card" : undefined}
      header={header ? { ...header, dot: answered === undefined } : undefined}
      question={<ChatMarkdown>{block.text}</ChatMarkdown>}
      consequence={consequence}
      answered={answered}
      actions={actions}
    >
      {children}
      {error ? <p className="text-meta text-destructive">{error}</p> : null}
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

function MultiQuestionAsk({
  block,
  canAnswer,
  onAnswer,
  messageId,
}: {
  block: AskBlock;
  canAnswer: boolean;
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
  const settled = block.status === "answered";

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
          const done = settled || isAnswered(get(question.id));
          const active = !settled && dotIndex === index;
          return (
            <button
              key={question.id}
              type="button"
              disabled={settled}
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
      {!settled ? (
        <span className="text-label text-muted-foreground">
          {index + 1}/{total}
        </span>
      ) : null}
    </div>
  );

  // Once settled the progress dots have nothing left to track, and a single
  // question is already the card's own question line: only the answer stays.
  const answerValue = (question: (typeof questions)[number]) => {
    const stored = block.answers?.[question.id];
    const labels = (stored?.selected ?? []).map(
      (id) => question.options?.find((option) => option.id === id)?.label ?? id,
    );
    if (stored?.other) labels.push(`${t`Other`}: ${stored.other}`);
    return stored?.skipped && labels.length === 0 ? t`Skipped` : labels.join(", ");
  };
  const hasStoredAnswers = Boolean(block.answers && Object.keys(block.answers).length > 0);
  const answered = settled ? (
    total === 1 ? (
      hasStoredAnswers ? (
        <div className="text-body text-foreground">{answerValue(current) || t`Answered`}</div>
      ) : (
        <div className="text-meta text-muted-foreground">
          <Trans>Answered</Trans>
        </div>
      )
    ) : (
      <div className="flex flex-col gap-3">
        {questions.map((question, qIndex) => (
          <div key={question.id}>
            <div className="text-meta text-muted-foreground">
              {qIndex + 1}. {question.question}
            </div>
            {/* Resolved from the composer: the user's own words are in their message bubble
                right below, so only the questions stay as a resolved trace (design D2). */}
            {hasStoredAnswers ? (
              <div className="text-body text-foreground">
                {answerValue(question) || t`Answered`}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    )
  ) : !canAnswer ? (
    <div className="text-meta text-muted-foreground">
      <Trans>No longer active</Trans>
    </div>
  ) : undefined;

  const showOtherField =
    !current.options?.length || !current.multiSelect || get(current.id).otherOpen;

  return (
    <FramedBlock
      className="mt-1.5"
      question={current.question}
      answered={answered}
      actions={
        answered === undefined ? (
          <FooterRow
            leading={
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
              </>
            }
            trailing={
              isLast ? (
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
              )
            }
          />
        ) : null
      }
    >
      {answered === undefined ? (
        <>
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
                placeholder={
                  current.options?.length ? t`Type a different answer` : t`Type your answer`
                }
                disabled={submitting}
              />
            </div>
          ) : null}
          {error ? <p className="mt-2 text-meta text-destructive">{error}</p> : null}
        </>
      ) : null}
    </FramedBlock>
  );
}
