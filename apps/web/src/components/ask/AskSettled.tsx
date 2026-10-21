import { useLingui } from "@lingui/react/macro";
import type { AnswerValue, AskSettledView } from "@rakazo/core";
import { cn, UserBubble } from "@rakazo/ui-web";
import { Check, CircleStop } from "lucide-react";

/** A question card once answered or no longer waiting: one muted line, then the answer. */
export function AskSettled({ view, className }: { view: AskSettledView; className?: string }) {
  const { t } = useLingui();
  const text = (value: AnswerValue) => (value.kind === "skipped" ? t`Skipped` : value.text);
  const bubble = view.kind === "answered" ? view.bubble : null;
  const lines = !bubble
    ? []
    : bubble.kind === "single"
      ? [text(bubble.value)]
      : bubble.lines.map((line) => `${line.label} — ${text(line.value)}`);
  const answer = lines.join("; ");
  const Icon = view.kind === "answered" ? Check : CircleStop;
  return (
    <div data-testid="ask-settled" className={cn("flex flex-col gap-3.5", className)}>
      <p className="flex min-w-0 items-center gap-1.5 px-4 text-meta text-muted-foreground">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span dir="auto" className="min-w-0 truncate">
          {view.line}
        </span>
        {view.kind === "inactive" ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0">{t`No longer active`}</span>
          </>
        ) : null}
      </p>
      {lines.length ? (
        <UserBubble role="group" aria-label={t`Your answer: ${answer}`} className="break-words">
          {lines.map((line, index) => (
            <span key={`${index}:${line}`} dir="auto" className="block">
              {line}
            </span>
          ))}
        </UserBubble>
      ) : null}
    </div>
  );
}
