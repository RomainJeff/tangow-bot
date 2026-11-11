import type { FieldSaveState } from "@tangow/core";
import type { ComponentPropsWithoutRef } from "react";
import { Button } from "./components/ui/button.js";
import { cn } from "./lib/utils.js";

export interface SaveMetaLabels {
  /** "Saving…" */
  saving: string;
  /** "Saved", followed by the time. */
  saved: string;
  /** "Could not save" */
  failed: string;
  /** "Retry" */
  retry: string;
}

export interface SaveMetaProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  state: FieldSaveState<unknown>;
  labels: SaveMetaLabels;
  onRetry: () => void;
  /** BCP 47 tag for the time; the device locale when omitted. */
  locale?: string;
}

/**
 * The only proof an automatic save happened or failed: "Saving…" while the
 * call runs, "Saved 14:02" for the few seconds the store keeps that state, and
 * "Could not save · Retry" until a save succeeds, with the server's reason in
 * place of "Could not save" when it gave one. At rest it is empty. The region
 * is always mounted so a screen reader hears each change.
 */
export function SaveMeta({ state, labels, onRetry, locale, className, ...props }: SaveMetaProps) {
  return (
    <span
      data-slot="save-meta"
      aria-live="polite"
      className={cn("max-w-1/2 text-end text-time text-muted-foreground tabular-nums", className)}
      {...props}
    >
      {state.kind === "saving" ? labels.saving : null}
      {state.kind === "saved" ? `${labels.saved} ${formatTime(state.at, locale)}` : null}
      {state.kind === "failed" ? (
        <span className="text-destructive">
          {state.reason || labels.failed}
          {" · "}
          <Button
            type="button"
            variant="link"
            onClick={onRetry}
            className="h-auto rounded-chip p-0 align-baseline text-time font-normal text-inherit underline"
          >
            {labels.retry}
          </Button>
        </span>
      ) : null}
    </span>
  );
}

function formatTime(at: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
}
