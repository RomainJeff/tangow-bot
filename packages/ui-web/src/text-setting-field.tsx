import { decideTextCommit } from "@tangow/core";
import type { ComponentPropsWithoutRef, KeyboardEvent, ReactNode } from "react";
import { useId, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { Label } from "./components/ui/label.js";
import { Textarea } from "./components/ui/textarea.js";
import { cn } from "./lib/utils.js";
import { SaveMeta, type SaveMetaLabels } from "./save-meta.js";
import type { FieldSave } from "./save-store.js";

export interface TextSettingFieldProps
  extends Omit<
    ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onChange" | "onBlur" | "onKeyDown" | "children" | "size"
  > {
  label: ReactNode;
  field: FieldSave<string>;
  labels: SaveMetaLabels & {
    /** "Restore unsaved text", offered when the server value moved under a draft. */
    restore?: string;
  };
  multiline?: boolean;
  rows?: number;
  /** An emptied field puts its old value back instead of saving (a name). */
  required?: boolean;
  /**
   * Emptying a non-empty field asks first: resolve `true` to clear it. Without
   * this callback an emptied field is saved without asking.
   */
  onConfirmClear?: () => boolean | Promise<boolean>;
  /** Keeps unsaved text in memory for the session, so closing the panel does not lose it. */
  keepDraft?: boolean;
  /** BCP 47 tag for the saved time and the count. */
  locale?: string;
  /** Classes for the input or textarea itself; `className` styles the wrapper. */
  controlClassName?: string;
  /** Classes for the row that holds the label and the save meta. */
  labelClassName?: string;
  /** Shows "n / max" beside the meta; needs `maxLength`. */
  counter?: boolean;
  /** Set to false when the caller shows the field's `SaveMeta` somewhere else. */
  meta?: boolean;
}

/**
 * A text setting that saves itself. Typing is local; leaving the field commits
 * the trimmed text through `field` when it changed. Escape drops the edit and
 * keeps focus. `className` styles the wrapper; every other native prop lands on
 * the input or textarea itself, which is what a test or a screen reader reaches.
 */
export function TextSettingField({
  label,
  field,
  labels,
  multiline,
  rows,
  required,
  onConfirmClear,
  keepDraft,
  locale,
  className,
  controlClassName,
  labelClassName,
  counter,
  meta = true,
  id,
  ...props
}: TextSettingFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const [edit, setEdit] = useState<string | null>(null);
  const { state, draft, conflict } = field;

  const restoredDraft = keepDraft && draft && !conflict ? draft.value : undefined;
  const resting = restoredDraft ?? (state.kind === "failed" ? state.value : field.value);
  const shown = edit ?? resting;
  const dirty = edit !== null || restoredDraft !== undefined;

  const drop = () => {
    setEdit(null);
    field.setDraft(null);
  };

  const onChange = (next: string) => {
    setEdit(next);
    if (keepDraft) field.setDraft(next === field.value ? null : next);
  };

  const onBlur = async () => {
    if (!dirty) return;
    const decision = decideTextCommit(field.value, shown, {
      required,
      confirmClear: onConfirmClear !== undefined,
    });
    if (decision === "commit") {
      drop();
      void field.save(shown.trim());
    } else if (decision === "confirm" && (await onConfirmClear?.())) {
      drop();
      void field.save("");
    } else {
      drop();
      if (decision === "skip") field.dismiss();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && dirty) {
      event.preventDefault();
      event.stopPropagation();
      drop();
    } else if (event.key === "Enter" && !multiline) {
      event.currentTarget.blur();
    }
  };

  const restore = () => {
    if (!draft) return;
    // Clearing first lets the draft begin again on the server value it now sits on.
    field.setDraft(null);
    field.setDraft(draft.value);
    setEdit(draft.value);
  };

  const control = {
    id: controlId,
    className: controlClassName,
    value: shown,
    "aria-invalid": state.kind === "failed" || undefined,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    onBlur,
    onKeyDown,
  };

  return (
    <div data-slot="text-setting-field" className={cn("flex flex-col gap-1.5", className)}>
      <div className={cn("flex items-baseline justify-between gap-3", labelClassName)}>
        <Label htmlFor={controlId} className="text-meta font-normal text-muted-foreground">
          {label}
        </Label>
        <span className="flex items-baseline gap-2">
          {conflict && labels.restore ? (
            <Button
              type="button"
              variant="link"
              onClick={restore}
              className="h-auto rounded-chip p-0 text-time font-normal text-muted-foreground underline hover:text-foreground"
            >
              {labels.restore}
            </Button>
          ) : null}
          {counter && props.maxLength !== undefined ? (
            <span
              data-slot="text-setting-count"
              className="font-mono text-mono text-muted-foreground tabular-nums"
            >
              {formatCount(shown.length, locale)} / {formatCount(props.maxLength, locale)}
            </span>
          ) : null}
          {meta ? (
            <SaveMeta state={state} labels={labels} onRetry={field.retry} locale={locale} />
          ) : null}
        </span>
      </div>
      {multiline ? (
        <Textarea rows={rows} {...(props as ComponentPropsWithoutRef<"textarea">)} {...control} />
      ) : (
        <Input {...props} {...control} />
      )}
    </div>
  );
}

function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(value);
}
