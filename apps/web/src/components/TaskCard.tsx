import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import {
  Button,
  ClippedPreview,
  Dialog,
  DialogContent,
  DialogTitle,
  Shimmer,
  Surface,
} from "@rakazo/ui-web";
import { CircleDashed, CircleX, FileText, StopCircle, X } from "lucide-react";
import { useState } from "react";

export type TaskCardState = "running" | "done" | "failed" | "cancelled";

const STATE_ICON = { running: CircleDashed, failed: CircleX, cancelled: StopCircle } as const;

function taskStatusLabel(state: TaskCardState, t: ReturnType<typeof useLingui>["t"]) {
  return state === "running" ? t`Running` : state === "failed" ? t`Failed` : t`Cancelled`;
}

/**
 * The visual card alone, with no click behaviour of its own: a delegated
 * task's result on `Surface variant="outlined"`, full column width — a
 * document glyph, the title, a status line (nothing for a finished task),
 * the brief in `meta` on two lines, a `border` hairline, then the result cut
 * to five lines. Used by `TaskCard`, which makes the whole thing a button.
 */
export function TaskCardSurface({
  title,
  state,
  meta,
  body,
  streaming = false,
  fadeFrom = "from-surface",
  onOpenBody,
}: {
  title: string;
  state: TaskCardState;
  meta?: string;
  body?: string;
  streaming?: boolean;
  fadeFrom?: string;
  /** Interactive only when passed — omit it when an ancestor already opens
   * the whole card, so the clipped result stays decorative. */
  onOpenBody?: () => void;
}) {
  const { t } = useLingui();
  const statusColorClass = state === "failed" ? "text-destructive" : "text-muted-foreground";
  const statusLabel = taskStatusLabel(state, t);
  const StatusIcon = state === "done" ? null : STATE_ICON[state];
  return (
    <Surface variant="outlined" className="w-full overflow-hidden">
      <div className="flex flex-col gap-1 px-4.5 py-4">
        <div className="flex items-center gap-2.5">
          <FileText className="size-4.5 shrink-0 text-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-row-name font-semibold text-foreground" dir="auto">
            {title}
          </span>
        </div>
        {state !== "done" ? (
          <div className="flex items-center gap-1.5 ps-7">
            {StatusIcon ? (
              <StatusIcon className={`size-3.5 ${statusColorClass}`} aria-hidden="true" />
            ) : null}
            {state === "running" ? (
              <Shimmer className={`text-label font-medium ${statusColorClass}`}>
                {statusLabel}
              </Shimmer>
            ) : (
              <span className={`text-label font-medium ${statusColorClass}`}>{statusLabel}</span>
            )}
          </div>
        ) : null}
        {meta ? (
          <p className="line-clamp-2 ps-7 text-meta text-muted-foreground" dir="auto">
            {meta}
          </p>
        ) : null}
      </div>
      {body ? (
        <div className="border-t border-border px-4.5 pt-3 pb-4">
          <ClippedPreview
            text={body}
            maxLines={5}
            fadeFrom={fadeFrom}
            {...(onOpenBody ? { onOpen: onOpenBody, ariaLabel: t`${title} · Opens in full` } : {})}
          >
            <div dir="auto" className="text-meta text-muted-foreground">
              <ChatMarkdown streaming={streaming}>{body}</ChatMarkdown>
            </div>
          </ClippedPreview>
        </div>
      ) : null}
    </Surface>
  );
}

/**
 * A delegated task's result (a subagent): the whole card is one target and
 * opens the task and its full result in a dialog. A finished task shows no
 * status word; running, failed and cancelled show their symbol and word
 * under the title (spec 9, A8).
 */
export function TaskCard({
  title,
  state,
  meta,
  body,
  streaming = false,
  testId,
}: {
  title: string;
  state: TaskCardState;
  meta?: string;
  body?: string;
  streaming?: boolean;
  testId?: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const opens = Boolean(body || meta);
  const card = (
    <TaskCardSurface title={title} state={state} meta={meta} body={body} streaming={streaming} />
  );

  if (!opens) {
    return <div data-testid={testId ?? "task-card"}>{card}</div>;
  }

  return (
    <>
      {/* The button lies over the card instead of wrapping it: the result's
          markdown can hold links, which cannot nest in a button. The card is
          inert, so its links take no focus or click; the label says it all. */}
      <div data-testid={testId ?? "task-card"} className="group relative">
        <div inert className="duration-(--duration-hover) ease-quiet group-hover:opacity-90">
          {card}
        </div>
        <button
          type="button"
          aria-label={[title, state === "done" ? null : taskStatusLabel(state, t), meta]
            .filter(Boolean)
            .join(", ")}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="absolute inset-0 rounded-[inherit]"
        />
      </div>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent
            showCloseButton={false}
            className="max-h-[85vh] w-[min(640px,94vw)] overflow-y-auto sm:max-w-none"
          >
            <div className="flex items-center justify-between">
              <DialogTitle>{title}</DialogTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t`Close`}
                onClick={() => setOpen(false)}
              >
                <X />
              </Button>
            </div>
            {meta ? (
              <p className="text-meta text-muted-foreground" dir="auto">
                {meta}
              </p>
            ) : null}
            {body ? (
              <div dir="auto">
                <ChatMarkdown streaming={streaming}>{body}</ChatMarkdown>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
