import { useLingui } from "@lingui/react/macro";
import { ASK_DRAFT_SUBJECT_MAX_LENGTH } from "@rakazo/contracts";
import { isMailAddress, LINE_BREAKS } from "@rakazo/core";
import { Textarea } from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

// The body's edit grammar, on a line: an outline on hover, the selected ring while typing.
const EDITABLE_LINE =
  "-mx-1.5 rounded-chip px-1.5 duration-(--duration-hover) ease-quiet hover:ring-1 hover:ring-option-ring-hover focus-within:ring-selected focus-within:ring-foreground";
const FIELD =
  "min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground";
// A line's controls take no room and no tap at rest, and show while the line is hovered or focused.
const LINE_CONTROL =
  "pointer-events-none -my-1.5 h-6 w-0 shrink-0 self-center overflow-hidden opacity-0 outline-none focus-visible:ring-1 focus-visible:ring-foreground group-focus-within/line:pointer-events-auto group-focus-within/line:opacity-100 group-hover/line:pointer-events-auto group-hover/line:opacity-100";
const SEPARATORS = /[\s,;]+/;

/** Whether a key press belongs to an input method still composing its text. */
function composing(event: KeyboardEvent) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** Whether a line's field holds a finished word that could not join the line: Send would leave it. */
export function heldBack(typed: string): boolean {
  return /[^\s,;][\s,;]/.test(typed);
}

/**
 * One recipient line of a draft: its addresses as text, each with its remove button once the line
 * is hovered or focused, then a field that takes more until the line is full. A finished word that
 * cannot join the line, not an address or past its room, stays in the field, marked.
 */
export function RecipientLine({
  id,
  label,
  addresses,
  typed,
  room,
  onChange,
  onTyped,
  more = [],
  strong,
}: {
  id: string;
  label: string;
  addresses: string[];
  /** The field's text, kept by the card so it outlives the line. */
  typed: string;
  /** The most addresses the line takes, or null when any number fits. */
  room: number | null;
  onChange: (addresses: string[]) => void;
  onTyped: (typed: string) => void;
  /** Hidden lines this one offers to open, shown with its controls. */
  more?: { label: string; open: () => void }[];
  strong?: boolean;
}) {
  const { t } = useLingui();
  const input = useRef<HTMLInputElement>(null);
  // A full line keeps its field while it has focus, so focus never falls out of the card.
  const [focused, setFocused] = useState(false);
  const full = room !== null && addresses.length >= room;

  /** Moves every address finished by a separator into the line, or every one when `final`. */
  function take(value: string, final: boolean) {
    const cut = final ? value.length : value.search(/[^\s,;]*$/);
    const kept = [...addresses];
    let back = "";
    for (const word of value.slice(0, cut).split(SEPARATORS).filter(Boolean)) {
      if (kept.some((address) => address.toLowerCase() === word.toLowerCase())) continue;
      if (isMailAddress(word) && (room === null || kept.length < room)) kept.push(word);
      else back += `${word} `;
    }
    if (kept.length > addresses.length) onChange(kept);
    onTyped(back + value.slice(cut));
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the line's blank space focuses its field, which keeps its own keyboard access.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field inside is the keyboard target.
    <div
      data-draft-field
      onClick={() => input.current?.focus()}
      className={`group/line flex cursor-text flex-wrap items-baseline gap-x-1.5 gap-y-0.5 break-words ${
        strong ? "" : "text-body font-normal"
      } ${EDITABLE_LINE}`}
    >
      <label htmlFor={id} className="font-normal text-muted-foreground">
        {label}
      </label>
      {addresses.map((address, index) => (
        <span key={address} className="inline-flex min-w-0 items-baseline break-all">
          {index < addresses.length - 1 ? `${address},` : address}
          <button
            type="button"
            aria-label={t`Remove ${address}`}
            onClick={(event) => {
              event.stopPropagation();
              // A full line shows its field only once the address is gone.
              flushSync(() => onChange(addresses.filter((each) => each !== address)));
              input.current?.focus();
            }}
            className={`${LINE_CONTROL} inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground group-focus-within/line:-me-1.5 group-focus-within/line:w-6 group-hover/line:-me-1.5 group-hover/line:w-6`}
          >
            <X className="size-3 shrink-0" aria-hidden="true" />
          </button>
        </span>
      ))}
      {full && !typed && !focused ? null : (
        <input
          ref={input}
          id={id}
          inputMode="email"
          dir="auto"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          aria-invalid={heldBack(typed) || undefined}
          onChange={(event) => take(event.target.value, false)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            take(typed, true);
          }}
          onKeyDown={(event) => {
            if (composing(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              take(typed, true);
            } else if (event.key === "Backspace" && !typed && addresses.length) {
              onChange(addresses.slice(0, -1));
            }
          }}
          className={`w-24 flex-1 ${FIELD} aria-invalid:text-destructive aria-invalid:underline aria-invalid:decoration-destructive aria-invalid:decoration-wavy`}
        />
      )}
      {more.length && !typed ? (
        // Cancels the line's gap so the hidden buttons take no room at rest. They fold away once
        // typing starts, so the field keeps its width.
        <span className="-ms-1.5 flex">
          {more.map((line) => (
            <button
              key={line.label}
              type="button"
              // Keeps the line focused, and so these buttons shown, while one is pressed.
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                line.open();
              }}
              className={`${LINE_CONTROL} rounded-chip text-body font-normal text-muted-foreground hover:text-foreground group-focus-within/line:ms-1.5 group-focus-within/line:w-auto group-focus-within/line:px-1 group-hover/line:ms-1.5 group-hover/line:w-auto group-hover/line:px-1`}
            >
              {line.label}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** The draft's subject, edited in place on one line that wraps when long. */
export function SubjectLine({
  label,
  subject,
  onChange,
}: {
  label: string;
  subject: string;
  onChange: (subject: string) => void;
}) {
  const id = useId();
  return (
    <div
      data-draft-field
      className={`flex items-start gap-1.5 text-body font-normal ${EDITABLE_LINE}`}
    >
      <label htmlFor={id} className="shrink-0 text-muted-foreground">
        {label}
      </label>
      <Textarea
        id={id}
        dir="auto"
        rows={1}
        value={subject}
        maxLength={ASK_DRAFT_SUBJECT_MAX_LENGTH}
        // The server takes a subject on one line.
        onKeyDown={(event) => {
          if (event.key === "Enter" && !composing(event)) event.preventDefault();
        }}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          if (pasted.search(LINE_BREAKS) === -1) return;
          event.preventDefault();
          const field = event.currentTarget;
          const clean = pasted.replace(LINE_BREAKS, " ");
          field.setRangeText(clean, field.selectionStart, field.selectionEnd, "end");
          onChange(field.value.slice(0, ASK_DRAFT_SUBJECT_MAX_LENGTH));
        }}
        onChange={(event) => onChange(event.target.value.replace(LINE_BREAKS, " "))}
        className={`min-h-0 w-auto flex-1 resize-none rounded-none border-0 p-0 text-body focus-visible:ring-0 md:text-body dark:bg-transparent ${FIELD}`}
      />
    </div>
  );
}
