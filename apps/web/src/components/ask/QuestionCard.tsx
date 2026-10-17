import { Trans, useLingui } from "@lingui/react/macro";
import { useAskCard } from "@rakazo/chat-ui/ask-card";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { ASK_ANSWER_MAX_LENGTH } from "@rakazo/contracts";
import type { AskCardBlock, AskForm, OptionId, Presenter } from "@rakazo/core";
import { motion } from "@rakazo/ui-tokens";
import { Button, cn, FramedBlock, OptionField, OptionTile } from "@rakazo/ui-web";
import { ChevronRight, Pencil } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AskSettled } from "./AskSettled";
import type { Departure } from "./flight";
import { advance, departure, fly } from "./flight";

/** Also where `linear()` easing is unknown (Safari before 17.2): `animate()` would throw on the spring. */
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
  !CSS.supports("animation-timing-function", "linear(0, 1)");

export function QuestionCard({
  block,
  form,
  messageId,
  canAnswer,
  onAnswer,
}: {
  block: AskCardBlock;
  form: AskForm;
  messageId: string;
  canAnswer: boolean;
  onAnswer: (wire: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const questionId = useId();
  const group = useRef<HTMLFieldSetElement>(null);
  const primaryAction = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const leaving = useRef<Departure | null>(null);
  const filling = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reopened = useRef(false);
  /** Set when focus was in the card as it moved on, so it follows to the next question. */
  const refocus = useRef(false);
  /** A chosen answer fills with the user's colour, then flies into its bubble, or fades with reduced motion. */
  const present: Presenter = (change, apply) => {
    if (change.kind === "reopen") {
      leaving.current = null;
      reopened.current = true;
      apply();
      return;
    }
    if (change.kind === "advance") {
      refocus.current = Boolean(card.current?.contains(document.activeElement));
      return advance(card.current, apply, reducedMotion());
    }
    const { from } = change;
    const leave = () => {
      leaving.current = card.current && !reducedMotion() ? departure(card.current, from) : null;
      if (!apply()) leaving.current = null;
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
  useEffect(() => () => clearTimeout(filling.current), []);
  useLayoutEffect(() => {
    if (settled && leaving.current && card.current && layer.current) {
      return fly(card.current, layer.current, leaving.current);
    }
  }, [settled]);
  useEffect(() => {
    if (error) focusAnswer();
  }, [error]);
  useLayoutEffect(() => {
    if (!shownStep || !refocus.current) return;
    refocus.current = false;
    focusAnswer();
  }, [shownStep]);

  const shell = (body: ReactNode, onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: digit shortcuts only while focus is inside the card
    <div ref={card} data-slot="question-card" className="relative mt-1.5" onKeyDown={onKeyDown}>
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
    <button
      key={line.questionId}
      type="button"
      data-slot="stack-line"
      disabled={busy}
      onClick={() => act.reopen(line.questionId)}
      className="-mx-2 flex min-h-11 items-center gap-2 rounded-row px-2 py-2.5 text-start text-row-name transition-colors duration-(--duration-hover) ease-quiet focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring enabled:hover:bg-pressed"
    >
      <span dir="auto" className="max-w-1/2 shrink-0 truncate text-muted-foreground">
        {line.label}
      </span>
      <span dir="auto" className="min-w-0 flex-1 truncate text-foreground">
        {line.value.kind === "skipped" ? t`Skipped` : line.value.text}
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
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
        className={arrives}
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
  const more = (count: number) => (count > 0 ? t`${count} more` : t`Last one`);
  const choices = question.options.length > 0;

  return shell(
    <FramedBlock
      className={arrives}
      question={
        <div className="flex flex-col">
          {pile}
          <div data-slot="stack-step" className={cn(pile.length > 0 && "pt-2.5")}>
            {left === null ? null : (
              <p data-slot="stack-head" className="flex min-w-0 items-baseline gap-1.5 pb-1">
                {question.header ? (
                  <>
                    <span dir="auto" className="min-w-0 truncate font-medium">
                      {question.header}
                    </span>
                    <span aria-hidden className="text-muted-foreground">
                      ·
                    </span>
                  </>
                ) : null}
                <span className="shrink-0 text-muted-foreground">{more(left)}</span>
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
        className={cn("flex min-w-0 flex-col gap-2", !actions && "pb-3.5")}
      >
        {question.options.map((option) => (
          <OptionTile
            key={option.id}
            selected={step.selected.includes(option.id)}
            filled={isFilled(option.id)}
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
