import type { AskDraft } from "@rakazo/contracts";
import { ASK_DRAFT_TEXT_MAX_LENGTH } from "@rakazo/contracts";

/** Where the body sits inside an effect's stored request. */
export type DraftPath = Array<string | number>;

export type DraftFailure = NonNullable<AskDraft["failure"]>;

/**
 * What an `ExternalEffect.draft` holds beside the effect's status. `proposed` is the bot's text;
 * the text that leaves is always the one at `path` in the stored request.
 */
export type DraftRecord = { path: DraftPath; proposed: string } & (
  | { state: "pending"; failure?: DraftFailure }
  | { state: "approved" }
  | { state: "sent"; at: string }
  | { state: "discarded" | "unsent" }
);

const EFFECT_STATUSES: Record<DraftRecord["state"], readonly string[]> = {
  pending: ["intended"],
  approved: ["approved", "executing"],
  sent: ["completed"],
  discarded: ["denied"],
  unsent: ["denied"],
};

export const DRAFT_DISCARDED_NOTE =
  "The user discarded this draft. Do not send it again unless they ask.";

/** A draft record that fits its effect's status, or undefined: the effect is then a plain one. */
export function readDraft(status: string, draft: unknown): DraftRecord | undefined {
  if (!isRecord(draft) || typeof draft.state !== "string") return undefined;
  if (!EFFECT_STATUSES[draft.state as DraftRecord["state"]]?.includes(status)) return undefined;
  if (typeof draft.proposed !== "string" || !isPath(draft.path)) return undefined;
  if (draft.state === "sent" && typeof draft.at !== "string") return undefined;
  if (
    draft.failure !== undefined &&
    (draft.state !== "pending" ||
      !isRecord(draft.failure) ||
      typeof draft.failure.reason !== "string")
  ) {
    return undefined;
  }
  return draft as DraftRecord;
}

/** What the bot reads once its draft left: exactly what was sent, and whether the user edited it. */
export function draftSentResult(
  draft: Pick<AskDraft, "recipients" | "subject"> | undefined,
  text: string,
  edited: boolean,
) {
  return {
    ok: true,
    sent: { recipients: draft?.recipients ?? [], subject: draft?.subject, body: text },
    editedByUser: edited,
    note: "The user sent this message from the draft card. Do not send it again.",
  };
}

/** Why a body cannot be sent, or undefined when it can. */
export function draftTextError(text: string): string | undefined {
  if (!text.trim()) return "This message is empty.";
  if (text.length > ASK_DRAFT_TEXT_MAX_LENGTH) {
    return `This message is longer than ${ASK_DRAFT_TEXT_MAX_LENGTH} characters.`;
  }
  return undefined;
}

export function valueAt(value: unknown, path: DraftPath): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      isRecord(current) || Array.isArray(current) ? current[key as never] : undefined,
    value,
  );
}

/** A copy of `value` with `next` at `path`, or undefined when the path does not exist. */
export function withValueAt(value: unknown, path: DraftPath, next: unknown): unknown {
  if (path.length === 0) return next;
  const [key, ...rest] = path;
  if (Array.isArray(value) && typeof key === "number" && key < value.length) {
    const child = withValueAt(value[key], rest, next);
    return child === undefined ? undefined : value.with(key, child);
  }
  if (isRecord(value) && typeof key === "string" && key in value) {
    const child = withValueAt(value[key], rest, next);
    return child === undefined ? undefined : { ...value, [key]: child };
  }
  return undefined;
}

/** Every line break a client may render, so a card can indent each one. */
export const LINE_BREAKS = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;

/** The card's text lines for a draft, read by clients that do not know drafts. */
export function askDraftDetail(draft: AskDraft): string {
  const lines = draft.app.account ? [`from: ${draft.app.account}`] : [];
  for (const role of ["to", "cc", "bcc"] as const) {
    const addresses = draft.recipients.filter((recipient) => recipient.role === role);
    if (addresses.length) {
      lines.push(`${role}: ${addresses.map((recipient) => recipient.address).join(", ")}`);
    }
  }
  // Continuation lines are indented so a line written inside the mail cannot pass for a header.
  if (draft.subject) lines.push(`subject: ${draft.subject.replace(LINE_BREAKS, "\n  ")}`);
  lines.push("body:", `  ${draft.body.replace(LINE_BREAKS, "\n  ")}`);
  return lines.join("\n");
}

function isPath(value: unknown): value is DraftPath {
  return (
    Array.isArray(value) &&
    value.every((key) => typeof key === "string" || (Number.isInteger(key) && key >= 0))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
