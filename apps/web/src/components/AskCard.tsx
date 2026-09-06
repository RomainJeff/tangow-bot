import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock, selectedAskActionLabel } from "@rakazo/core";
import { Button, Input } from "@rakazo/ui-web";
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

function secretFieldLabel(purpose: AskBlock["purpose"]): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
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
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;
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

  return (
    <div
      data-testid={secretInput ? "secret-ask-card" : undefined}
      className="max-w-[74%] rounded-2xl border border-border bg-card px-5 py-4"
    >
      <div className="text-[15.5px] leading-[1.5] text-foreground">
        <ChatMarkdown>{block.text}</ChatMarkdown>
      </div>
      {secretInput && block.credential ? (
        <div className="mt-2 break-all text-[13px] text-muted-foreground">
          {block.credential.origin}
        </div>
      ) : null}
      {block.detail && !secretInput ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground">
          {block.detail}
        </pre>
      ) : null}
      {block.status === "answered" ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-success">
          {formatAnsweredState(
            block.answer,
            Boolean(approvalActions),
            secretInput,
            approvalActions?.find((action) => action.id === block.answer)?.outcome,
            askActions,
          )}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : askActions?.length ? (
        <div className="mt-3.5 space-y-1.5">
          {askActions.map((action) => (
            <Button
              key={action.id}
              variant={approvalActions && action.id === "allow" ? "default" : "outline"}
              className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start font-normal"
              disabled={submitting}
              onClick={() => void submitAnswer(action.id)}
            >
              {pendingAction === action.id ? (
                <Trans>Sending…</Trans>
              ) : approvalActions ? (
                approvalActionLabel(action.id, action.label, action.outcome)
              ) : (
                action.label
              )}
            </Button>
          ))}
          {!approvalActions ? (
            editing ? (
              <form
                className="flex flex-col gap-2 pt-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitAnswer(answer);
                }}
              >
                <Input
                  aria-label={t`Other answer`}
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  placeholder={t`Type a different answer`}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={submitting}
                    onClick={() => {
                      setAnswer("");
                      setEditing(false);
                    }}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                  <Button type="submit" disabled={!answer.trim() || submitting}>
                    {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start px-3.5 py-2 text-start font-normal text-muted-foreground"
                disabled={submitting}
                onClick={() => setEditing(true)}
              >
                <Trans>Other answer…</Trans>
              </Button>
            )
          ) : null}
        </div>
      ) : secretInput ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <Input
            aria-label={secretLabel}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={secretLabel}
          />
          <Button type="submit" className="self-start" disabled={answer.length === 0 || submitting}>
            {submitting ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </form>
      ) : editing ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <Input
            aria-label={t`Answer`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={t`Type your answer`}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={!answer.trim() || submitting}>
              {submitting ? <Trans>Sending…</Trans> : <Trans>Send answer</Trans>}
            </Button>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setAnswer("");
                setEditing(false);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3.5 flex gap-2">
          <Button disabled={submitting} onClick={() => void submitAnswer("approved")}>
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send it</Trans>}
          </Button>
          <Button variant="outline" disabled={submitting} onClick={() => setEditing(true)}>
            <Trans>Edit first</Trans>
          </Button>
        </div>
      )}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </div>
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

  function update(id: string, patch: Partial<LocalAnswer>) {
    setAnswers((prev) => ({ ...prev, [id]: { ...get(id), ...patch } }));
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
      update(question.id, { selected, skipped: false });
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
      const answered = isAnswered(state);
      const other = state.other.trim();
      if (answered) {
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

  const answered = block.status === "answered";

  return (
    <div className="max-w-[74%] rounded-2xl border border-border bg-card px-5 py-4">
      {/* progress dots + counter */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-1.5">
          {questions.map((question, dotIndex) => {
            const done = answered || isAnswered(get(question.id));
            const active = !answered && dotIndex === index;
            return (
              <button
                key={question.id}
                type="button"
                disabled={answered}
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
        {!answered ? (
          <span className="text-[12px] font-medium text-muted-foreground">
            {index + 1}/{total}
          </span>
        ) : null}
      </div>

      {answered ? (
        <div className="space-y-3">
          {questions.map((question, qIndex) => {
            const stored = block.answers?.[question.id];
            const labels = (stored?.selected ?? []).map(
              (id) => question.options?.find((option) => option.id === id)?.label ?? id,
            );
            if (stored?.other) labels.push(`${t`Other`}: ${stored.other}`);
            const value = stored?.skipped && labels.length === 0 ? t`Skipped` : labels.join(", ");
            return (
              <div key={question.id}>
                <div className="text-[13px] font-medium text-muted-foreground">
                  {qIndex + 1}. {question.question}
                </div>
                <div className="text-[14.5px] text-foreground">{value || t`Answered`}</div>
              </div>
            );
          })}
        </div>
      ) : !canAnswer ? (
        <div className="text-[13.5px] font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : (
        <div>
          {current.header ? (
            <div className="mb-1 inline-block rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] font-medium text-muted-foreground">
              {current.header}
            </div>
          ) : null}
          <div className="text-[15.5px] leading-[1.5] text-foreground">{current.question}</div>

          <div className="mt-3 space-y-1.5">
            {current.options?.map((option) => {
              const selected = get(current.id).selected.includes(option.id);
              return (
                <Button
                  key={option.id}
                  type="button"
                  variant={selected ? "default" : "outline"}
                  className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start font-normal"
                  disabled={submitting}
                  onClick={() => toggleOption(current, option.id)}
                >
                  {current.multiSelect ? (selected ? "☑ " : "☐ ") : null}
                  {option.label}
                </Button>
              );
            })}
            {current.options?.length && current.multiSelect ? (
              <Button
                type="button"
                variant={get(current.id).otherOpen ? "default" : "outline"}
                className="h-auto w-full justify-start whitespace-normal px-3.5 py-3 text-start font-normal"
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
                {get(current.id).otherOpen ? "☑ " : "☐ "}
                <Trans>Other…</Trans>
              </Button>
            ) : null}
          </div>
          {/* Single-select and free-text questions type inline; multi-select reveals the field
              only when the "Other" checkbox is on. */}
          {!current.options?.length || !current.multiSelect || get(current.id).otherOpen ? (
            <div className="mt-2.5">
              {current.options?.length && !current.multiSelect ? (
                <div className="mb-1 text-[12px] text-muted-foreground">
                  <Trans>Or type your own answer</Trans>
                </div>
              ) : null}
              <Input
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

          <div className="mt-4 flex items-center justify-between">
            <div className="flex gap-2">
              {index > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={submitting}
                  onClick={() => setIndex(index - 1)}
                >
                  <Trans>Back</Trans>
                </Button>
              ) : null}
              {current.required === false ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={submitting}
                  onClick={() => {
                    update(current.id, { selected: [], other: "", skipped: true });
                    if (!isLast) setIndex(index + 1);
                  }}
                >
                  <Trans>Skip</Trans>
                </Button>
              ) : null}
            </div>
            {isLast ? (
              <Button
                type="button"
                disabled={submitting || !requiredSatisfied}
                onClick={() => void submit()}
              >
                {submitting ? <Trans>Sending…</Trans> : <Trans>Send answers</Trans>}
              </Button>
            ) : (
              <Button type="button" disabled={submitting} onClick={() => setIndex(index + 1)}>
                <Trans>Next</Trans>
              </Button>
            )}
          </div>
          {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
        </div>
      )}
    </div>
  );
}
