import { Trans, useLingui } from "@lingui/react/macro";
import { useAskCard } from "@rakazo/chat-ui/ask-card";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { ASK_ANSWER_MAX_LENGTH } from "@rakazo/contracts";
import type { AskCardBlock, AskForm, FormOption, OptionId, Presenter } from "@rakazo/core";
import { motion } from "@rakazo/ui-tokens";
import { Button, cn, FramedBlock, OptionField, OptionTile, StackLine } from "@rakazo/ui-web";
import { Pencil } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AskSettled } from "./AskSettled";
import type { Departure, Steady } from "./flight";
import { advance, departure, fly, reveal, steady } from "./flight";

/** Also where `linear()` easing is unknown (Safari before 17.2): `animate()` would throw on the spring. */
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
  !CSS.supports("animation-timing-function", "linear(0, 1)");

export function QuestionCard({
  block,
  form,
  messageId,
  canAnswer,
  waitingOn,
  onAnswer,
}: {
  block: AskCardBlock;
  form: AskForm;
  messageId: string;
  canAnswer: boolean;
  /** The person who answers it instead, when it waits on someone else's run in a group. */
  waitingOn?: string;
  onAnswer: (wire: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const questionId = useId();
  const group = useRef<HTMLFieldSetElement>(null);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const leaving = useRef<Departure | null>(null);
  /** Holds the thread's follow of its end into the movement, from the commit until it lands. */
  const held = useRef<Steady | null>(null);
  const filling = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reopened = useRef(false);
  /** Set when focus was in the card as it moved on, so it follows to the next question. */
  const refocus = useRef(false);
  const grown = useRef(false);
  const release = () => {
    held.current?.stop();
    held.current = null;
  };
  /** A chosen answer fills with the user's colour, then flies into its bubble, or fades with reduced motion. */
  const present: Presenter = (change, apply) => {
    if (change.kind === "reopen") {
      leaving.current = null;
      release();
      reopened.current = true;
      apply();
      return;
    }
    if (change.kind === "advance") {
      refocus.current = Boolean(card.current?.contains(document.activeElement));
      return advance(card.current, apply, reducedMotion());
    }
    const { from } = change;
    release();
    if (card.current && !reducedMotion()) held.current = steady(card.current);
    const leave = () => {
      leaving.current = card.current && !reducedMotion() ? departure(card.current, from) : null;
      if (apply()) return;
      leaving.current = null;
      release();
    };
    if (from.kind === "button") leave();
    else filling.current = setTimeout(leave, motion.fill);
  };
  const { view, act } = useAskCard({
    block,
    form,
    messageId,
    waiting: canAnswer,
    onAnswer,
    present,
  });
  const [openedHere] = useState(view.kind === "open");
  const error = view.kind === "open" ? view.error : null;
  const settled = view.kind === "settled";
  const shownStep = view.kind === "open" ? (view.step?.question.id ?? "recap") : null;
  const primary = view.kind === "open" ? view.primary : null;
  /** The chosen tile, the field, or the first tile; the recap's Send. */
  const focusAnswer = () => {
    const tiles = group.current;
    const target = tiles
      ? (tiles.querySelector<HTMLElement>('[aria-pressed="true"]') ??
        tiles.querySelector<HTMLElement>('[data-slot="option-field"] input') ??
        tiles.querySelector<HTMLElement>("button"))
      : primaryAction.current;
    target?.focus();
  };
  useEffect(
    () => () => {
      clearTimeout(filling.current);
      release();
    },
    [],
  );
  useLayoutEffect(() => {
    if (!settled) return;
    const steadied = held.current;
    held.current = null;
    if (steadied && leaving.current && card.current && layer.current) {
      return fly(card.current, layer.current, leaving.current, steadied);
    }
    steadied?.stop();
  }, [settled]);
  useEffect(() => {
    if (error) focusAnswer();
  }, [error]);
  useLayoutEffect(() => {
    if (!shownStep || !refocus.current) return;
    refocus.current = false;
    focusAnswer();
  }, [shownStep]);
  // The card grows down under the fold as it moves on or shows its Next: its foot comes into view.
  useLayoutEffect(() => {
    const block = card.current?.querySelector<HTMLElement>('[data-slot="framed-block"]');
    if (!shownStep || !block) return;
    if (grown.current) reveal(block, reducedMotion());
    grown.current = true;
  }, [shownStep, primary]);

  const shell = (body: ReactNode, onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: digit shortcuts only while focus is inside the card
    <div ref={card} data-slot="question-card" className="relative" onKeyDown={onKeyDown}>
      <div
        ref={layer}
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 overflow-x-visible overflow-y-clip"
      />
      {body}
    </div>
  );

  if (view.kind === "settled") {
    return shell(
      <AskSettled
        view={view.settled}
        waitingOn={waitingOn}
        className={
          openedHere && !leaving.current
            ? "animate-in fade-in duration-(--duration-arrive)"
            : undefined
        }
      />,
    );
  }

  const { lines, step, busy, filled } = view;
  const isFilled = (id: OptionId) => filled?.kind === "option" && filled.optionId === id;
  const optionDetail = ({ description, recommended }: FormOption) => {
    if (!recommended) return description;
    return description ? t`Recommended · ${description}` : t`Recommended`;
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true'], [data-slot='option-field']")) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const tiles = [
        ...(group.current?.querySelectorAll<HTMLButtonElement>('[data-slot="option-tile"]') ?? []),
      ];
      const index = tiles.indexOf(target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      tiles[(index + (event.key === "ArrowDown" ? 1 : tiles.length - 1)) % tiles.length]?.focus();
      return;
    }
    const option = /^[1-9]$/.test(event.key)
      ? step?.question.options[Number(event.key) - 1]
      : undefined;
    if (option) {
      event.preventDefault();
      act.tap(option.id);
    }
  }

  const actions =
    step?.skip || view.primary ? (
      <>
        {step?.skip ? (
          <Button variant="tertiary" size="capsule" disabled={busy} onClick={act.skip}>
            <Trans>Skip</Trans>
          </Button>
        ) : null}
        {view.primary ? (
          <Button
            ref={primaryAction}
            variant="capsule"
            size="capsule"
            disabled={busy}
            onClick={act.confirm}
          >
            {view.primary === "next" ? <Trans>Next</Trans> : <Trans>Send</Trans>}
          </Button>
        ) : null}
      </>
    ) : undefined;

  const pile = lines.map((line) => (
    <StackLine
      key={line.questionId}
      disabled={busy}
      onClick={() => act.reopen(line.questionId)}
      label={line.label}
      value={line.value.kind === "skipped" ? t`Skipped` : line.value.text}
    />
  ));
  const alert = view.error ? (
    <p role="alert" className="text-meta text-destructive">
      {view.error}
    </p>
  ) : null;
  const arrives = reopened.current ? "animate-in fade-in duration-(--duration-arrive)" : undefined;

  if (!step) {
    return shell(
      <FramedBlock
        className={cn("relative", arrives)}
        question={
          <div className="flex flex-col pb-0.5">
            {pile}
            {alert ? <div className="pt-1 pb-2">{alert}</div> : null}
          </div>
        }
        actions={actions}
      />,
      onKeyDown,
    );
  }

  const { question, left } = step;
  const more = (count: number) => t`${count} more`;
  const mark = left === null ? null : left > 0 ? more(left) : step.reopened ? null : t`Last one`;
  const choices = question.options.length > 0;

  return shell(
    <FramedBlock
      className={cn("relative", arrives)}
      question={
        <div className="flex flex-col">
          {pile}
          <div data-slot="stack-step" className={cn(pile.length > 0 && "pt-2.5")}>
            {left === null || (!question.header && !mark) ? null : (
              <p data-slot="stack-head" className="flex min-w-0 items-baseline gap-1.5 pb-1">
                {question.header ? (
                  <span dir="auto" className="min-w-0 truncate font-medium">
                    {question.header}
                  </span>
                ) : null}
                {question.header && mark ? (
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                ) : null}
                {mark ? <span className="shrink-0 text-muted-foreground">{mark}</span> : null}
              </p>
            )}
            <div id={questionId}>
              <ChatMarkdown allowImages={false}>{question.text}</ChatMarkdown>
            </div>
          </div>
        </div>
      }
      consequence={
        block.detail ? (
          <span dir="auto" className="whitespace-pre-wrap">
            {block.detail}
          </span>
        ) : undefined
      }
      actions={actions}
    >
      <fieldset
        ref={group}
        aria-labelledby={questionId}
        disabled={busy}
        className="flex min-w-0 flex-col gap-2"
      >
        {question.options.map((option) => (
          <OptionTile
            key={option.id}
            selected={step.selected.includes(option.id)}
            filled={isFilled(option.id)}
            detail={optionDetail(option)}
            onClick={() => act.tap(option.id)}
          >
            {option.label}
          </OptionTile>
        ))}
        {step.field ? (
          <OptionField
            filled={filled?.kind === "field"}
            confirms={left !== null}
            sendLabel={left === null ? t`Send` : t`Next`}
            canSend={step.field.canSend}
            onSend={act.confirm}
            aria-label={choices ? t`Other answer` : t`Answer`}
            placeholder={choices ? t`Other…` : t`Type your answer`}
            autoFocus={choices}
            maxLength={ASK_ANSWER_MAX_LENGTH}
            value={step.field.text}
            onChange={(event) => act.typeOther(event.target.value)}
          />
        ) : (
          <OptionTile
            trailing={<Pencil aria-hidden className="size-4 shrink-0" />}
            className="font-normal text-muted-foreground"
            onClick={act.openOther}
          >
            <Trans>Other…</Trans>
          </OptionTile>
        )}
        {alert}
      </fieldset>
    </FramedBlock>,
    onKeyDown,
  );
}
