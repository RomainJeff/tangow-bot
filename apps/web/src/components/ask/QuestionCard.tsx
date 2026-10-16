import { Trans, useLingui } from "@lingui/react/macro";
import { useAskCard } from "@rakazo/chat-ui/ask-card";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { ASK_ANSWER_MAX_LENGTH } from "@rakazo/contracts";
import type { AskCardBlock, AskForm, OptionId, Presenter } from "@rakazo/core";
import { motion } from "@rakazo/ui-tokens";
import { Button, cn, FramedBlock, OptionField, OptionTile } from "@rakazo/ui-web";
import { Pencil } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { AskSettled } from "./AskSettled";

/** A chosen answer fills with the user's colour, then the card settles with a fade. */
const present: Presenter = (change, apply) => {
  if (change.kind === "settle" && change.from.kind !== "button") setTimeout(apply, motion.fill);
  else apply();
};

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
  useEffect(() => {
    if (!error) return;
    group.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"], [data-slot="option-field"] input')
      ?.focus();
  }, [error]);

  if (view.kind === "settled") {
    return (
      <AskSettled
        view={view.settled}
        className={cn("mt-1.5", openedHere && "animate-in fade-in duration-(--duration-arrive)")}
      />
    );
  }

  const { step, busy, filled } = view;
  const { question } = step;
  const choices = question.options.length > 0;
  const isFilled = (id: OptionId) => filled?.kind === "option" && filled.optionId === id;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true'], [data-slot='option-field']")) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const tiles = [...(group.current?.querySelectorAll("button") ?? [])];
      const index = tiles.indexOf(target as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      tiles[(index + (event.key === "ArrowDown" ? 1 : tiles.length - 1)) % tiles.length]?.focus();
      return;
    }
    const option = /^[1-9]$/.test(event.key) ? question.options[Number(event.key) - 1] : undefined;
    if (option) {
      event.preventDefault();
      act.tap(option.id);
    }
  }

  const actions =
    step.skip || view.send ? (
      <>
        {step.skip ? (
          <Button variant="tertiary" size="capsule" disabled={busy} onClick={act.skip}>
            <Trans>Skip</Trans>
          </Button>
        ) : null}
        {view.send ? (
          <Button variant="capsule" size="capsule" disabled={busy} onClick={act.confirm}>
            <Trans>Send</Trans>
          </Button>
        ) : null}
      </>
    ) : undefined;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: digit shortcuts only while focus is inside the card
    <div onKeyDown={onKeyDown}>
      <FramedBlock
        className="mt-1.5"
        question={
          <div id={questionId}>
            <ChatMarkdown allowImages={false}>{question.text}</ChatMarkdown>
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
              sendLabel={t`Send`}
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
          {view.error ? (
            <p role="alert" className="text-meta text-destructive">
              {view.error}
            </p>
          ) : null}
        </fieldset>
      </FramedBlock>
    </div>
  );
}
