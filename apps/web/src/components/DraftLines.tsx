import { useLingui } from "@lingui/react/macro";
import { ASK_DRAFT_SUBJECT_MAX_LENGTH } from "@rakazo/contracts";
import { isMailAddress } from "@rakazo/core";
import { X } from "lucide-react";
import { useId, useRef, useState } from "react";

// The body's edit grammar, on a line: an outline on hover, the selected ring while typing.
const EDITABLE_LINE =
  "-mx-1.5 rounded-chip px-1.5 duration-(--duration-hover) ease-quiet hover:ring-1 hover:ring-option-ring-hover focus-within:ring-selected focus-within:ring-foreground";
const FIELD =
  "min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground";

/**
 * One recipient line of a draft: its addresses as text, each with its remove button once the line
 * is hovered or focused, then a field that takes more until the line is full. Only addresses that
 * are ones join the line; anything else stays in the field, marked invalid.
 */
export function RecipientLine({
  label,
  addresses,
  room,
  onChange,
  onInvalidChange,
  strong,
}: {
  label: string;
  addresses: string[];
  /** The most addresses the line takes, or null when any number fits. */
  room: number | null;
  onChange: (addresses: string[]) => void;
  /** Whether the field holds text that is not an address, which Send would leave behind. */
  onInvalidChange: (invalid: boolean) => void;
  strong?: boolean;
}) {
  const { t } = useLingui();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  // Marked once a word is finished, by a separator or by leaving the field, never mid-word.
  const [invalid, setInvalid] = useState(false);
  const full = room !== null && addresses.length >= room;

  /**
   * Keeps `value` in the field, moving every address finished by a separator into the line, or
   * every one when `final`. What is not an address stays in the field.
   */
  function take(value: string, final: boolean) {
    const cut = final ? value.length : value.search(/[^\s,;]*$/);
    const words = value
      .slice(0, cut)
      .split(/[\s,;]+/)
      .filter(Boolean);
    const added = [...new Set(words.filter(isMailAddress))].filter(
      (word) => !addresses.includes(word),
    );
    const fits = room === null ? added : added.slice(0, Math.max(0, room - addresses.length));
    if (fits.length) onChange([...addresses, ...fits]);
    const rejected = words.filter((word) => !isMailAddress(word));
    const next = [...rejected, value.slice(cut)].filter(Boolean).join(" ");
    setTyped(next);
    setInvalid(rejected.length > 0);
    onInvalidChange(next.split(/[\s,;]+/).some((word) => word && !isMailAddress(word)));
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
              onChange(addresses.filter((each) => each !== address));
              input.current?.focus();
            }}
            // No room, no tap and no sight at rest, still reachable by keyboard.
            className="pointer-events-none inline-flex w-0 self-center overflow-hidden rounded-full text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:ms-1 focus-visible:w-3 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-foreground group-focus-within/line:pointer-events-auto group-focus-within/line:ms-1 group-focus-within/line:w-3 group-focus-within/line:opacity-100 group-hover/line:pointer-events-auto group-hover/line:ms-1 group-hover/line:w-3 group-hover/line:opacity-100"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      {full ? null : (
        <input
          ref={input}
          id={id}
          inputMode="email"
          dir="auto"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          aria-invalid={invalid || undefined}
          onChange={(event) => take(event.target.value, false)}
          onBlur={() => take(typed, true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              take(typed, true);
            } else if (event.key === "Backspace" && !typed && addresses.length) {
              onChange(addresses.slice(0, -1));
            }
          }}
          className={`w-24 flex-1 ${FIELD} aria-invalid:text-destructive`}
        />
      )}
    </div>
  );
}

/** The draft's subject, one line edited in place. */
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
      className={`flex items-baseline gap-1.5 text-body font-normal ${EDITABLE_LINE}`}
    >
      <label htmlFor={id} className="shrink-0 text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        dir="auto"
        value={subject}
        maxLength={ASK_DRAFT_SUBJECT_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        className={`flex-1 ${FIELD}`}
      />
    </div>
  );
}
