import { useLingui } from "@lingui/react/macro";
import { ASK_DRAFT_SUBJECT_MAX_LENGTH } from "@tangow/contracts";
import { heldBack, LINE_BREAKS, takeAddresses } from "@tangow/core";
import { Textarea } from "@tangow/ui-web";
import { X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

// The body's edit grammar, on a line: an outline on hover, the selected ring while typing. Read,
// a line is its text on the card; editing, the same cell becomes a field on the well.
const LINE_CELL =
  "flex min-w-0 cursor-text flex-wrap items-center gap-x-1.5 rounded-card transition-[background-color,box-shadow] duration-(--duration-hover) ease-quiet hover:ring-1 hover:ring-option-ring-hover focus-within:ring-selected focus-within:ring-foreground";
const FIELD =
  "min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground";
// Only a line being edited has controls, at the 24 px a finger or a pointer needs.
const EDIT_CONTROL =
  "inline-flex h-6 shrink-0 items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-foreground";

/** A line's label, outside its field, centred on the field's first line. */
export function RowLabel({
  children,
  editing,
  htmlFor,
}: {
  children: ReactNode;
  editing?: boolean;
  htmlFor?: string;
}) {
  const className = `flex ${editing ? "h-11" : "h-6"} items-center text-muted-foreground`;
  return htmlFor ? (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ) : (
    <span className={className}>{children}</span>
  );
}

/** A line the person cannot change, as text under its label. */
export function ReadRow({
  label,
  strong,
  children,
}: {
  label: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <RowLabel>{label}</RowLabel>
      <div
        className={`flex min-h-6 min-w-0 items-center break-words px-4 ${strong ? "font-medium" : ""}`}
      >
        <span className="min-w-0">{children}</span>
      </div>
    </>
  );
}

/** Whether a key press belongs to an input method still composing its text. */
function composing(event: KeyboardEvent) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * One recipient line of a draft, a label and its cell in the card's grid. Read, the addresses are
 * text; editing, the cell is a field holding a chip per address, each with its remove button, then
 * room to type more until the line is full. A finished word
 * that cannot join the line, not an address or past its room, stays in the field, marked.
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
  editing,
  sending,
  onEdit,
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
  editing: boolean;
  /** A send is on its way: the line keeps its shape, read-only. */
  sending: boolean;
  /** Starts editing the card's lines, when the line has no field to focus. */
  onEdit: () => void;
}) {
  const { t } = useLingui();
  const input = useRef<HTMLInputElement>(null);
  const cell = useRef<HTMLDivElement>(null);
  // A full line keeps its field while it has focus, so focus never falls out of the card.
  const [focused, setFocused] = useState(false);
  const full = room !== null && addresses.length >= room;
  const hasInput = !(full && !typed && !focused);

  /** Moves every address finished by a separator into the line, or every one when `final`. */
  function take(value: string, final: boolean) {
    const next = takeAddresses(addresses, value, room, final);
    if (next.addresses.length > addresses.length) onChange(next.addresses);
    onTyped(next.typed);
  }

  return (
    <>
      <RowLabel htmlFor={hasInput ? id : undefined} editing={editing}>
        {label}
      </RowLabel>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click on the line's blank space focuses its field, which keeps its own keyboard access. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the field inside is the keyboard target. */}
      <div
        ref={cell}
        data-draft-field
        // A full line has no field to tab to: the line itself is the stop, and focusing it
        // starts editing, which brings each address's remove button.
        {...(hasInput ? {} : { tabIndex: 0, role: "group", "aria-label": label })}
        onClick={() => {
          if (sending) return;
          if (input.current) return input.current.focus();
          // A full line has no field: pressing it starts editing and focuses its first remove button.
          flushSync(onEdit);
          cell.current?.querySelector("button")?.focus();
        }}
        className={`${LINE_CELL} ${
          editing ? "min-h-11 gap-y-1 bg-well px-2 py-2" : "min-h-6 px-4 break-words"
        } ${strong && !editing ? "font-medium" : ""}`}
      >
        {addresses.map((address, index) => (
          <span
            key={address}
            className={
              editing
                ? "inline-flex h-7 min-w-0 max-w-full items-center rounded-chip bg-surface ps-2 pe-0.5 text-row-name font-medium shadow-group"
                : "inline-flex min-w-0 items-baseline break-all"
            }
          >
            <span className="min-w-0 break-all">
              {!editing && index < addresses.length - 1 ? `${address},` : address}
            </span>
            {editing ? (
              <button
                type="button"
                aria-label={t`Remove ${address}`}
                disabled={sending}
                onClick={(event) => {
                  event.stopPropagation();
                  // A full line shows its field only once the address is gone.
                  flushSync(() => onChange(addresses.filter((each) => each !== address)));
                  input.current?.focus();
                }}
                className={`${EDIT_CONTROL} w-6 rounded-full text-muted-foreground hover:text-foreground`}
              >
                <X className="size-3.5 shrink-0" aria-hidden="true" />
              </button>
            ) : null}
          </span>
        ))}
        {hasInput ? (
          <input
            ref={input}
            id={id}
            readOnly={sending}
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
            className={`w-24 flex-1 ${FIELD} ${
              editing ? "px-2 text-body" : ""
            } aria-invalid:text-destructive aria-invalid:underline aria-invalid:decoration-destructive aria-invalid:decoration-wavy`}
          />
        ) : null}
        {editing && more.length && !typed ? (
          // They fold away once typing starts, so the field keeps its width.
          <span className="ms-auto flex gap-0.5">
            {more.map((line) => (
              <button
                key={line.label}
                type="button"
                disabled={sending}
                // Keeps the line focused, and so these buttons shown, while one is pressed.
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  line.open();
                }}
                className={`${EDIT_CONTROL} h-7 rounded-row px-2 text-row-name font-medium text-foreground`}
              >
                {line.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>
    </>
  );
}

/** The draft's subject, edited in place on one line that wraps when long. */
export function SubjectLine({
  label,
  subject,
  onChange,
  editing,
  sending,
}: {
  label: string;
  subject: string;
  onChange: (subject: string) => void;
  editing: boolean;
  /** A send is on its way: the line keeps its shape, read-only. */
  sending: boolean;
}) {
  const id = useId();
  return (
    <>
      <RowLabel htmlFor={id} editing={editing}>
        {label}
      </RowLabel>
      <div
        data-draft-field
        className={`${LINE_CELL} items-start ${editing ? "min-h-11 bg-well px-4 py-2.5" : "min-h-6 px-4"}`}
      >
        <Textarea
          id={id}
          dir="auto"
          rows={1}
          value={subject}
          readOnly={sending}
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
          className={`min-h-0 w-auto flex-1 resize-none rounded-none border-0 p-0 focus-visible:ring-0 dark:bg-transparent ${
            editing ? "text-body md:text-body" : "text-row-name md:text-row-name"
          } ${FIELD}`}
        />
      </div>
    </>
  );
}
