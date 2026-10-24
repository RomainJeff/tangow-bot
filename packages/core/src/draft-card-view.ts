import type { AskDraft } from "@rakazo/contracts";
import { askDraftState } from "@rakazo/contracts";

/** How long a discarded draft can still be brought back before the bot hears of it. */
export const DRAFT_UNDO_MS = 5000;

/** A mail draft card as the thread shows it. */
export type DraftCard = {
  status?: "pending" | "answered";
  answer?: string;
  failed?: true;
  draft: AskDraft;
};

/** What the person is doing on the card. It stays on this device until the card is sent. */
export type DraftLocal = {
  /** The text differs from the one the card shows. */
  edited: boolean;
  focused: boolean;
  /**
   * A tap on its way: Send until the server takes it, Discard during its Undo window, then
   * Discarding once it is on its way and can no longer be undone.
   */
  pending: "send" | "discard" | "discarding" | null;
  /** The card is the one its run waits on, so a tap reaches it. */
  canAnswer: boolean;
  /** The viewer owns the run: only they may edit, send or discard the draft. */
  owner: boolean;
};

export type DraftCardView =
  | {
      kind: "open";
      /** Another member sees the draft but cannot act on it. */
      readOnly: boolean;
      /** Sending freezes the text and the actions until the server answers. */
      sending: boolean;
      status: "editing" | "edited" | "not_sent" | null;
      failure?: NonNullable<AskDraft["failure"]>;
    }
  | { kind: "inactive" }
  | { kind: "sent"; at: string }
  | { kind: "discarded"; undo: boolean }
  | { kind: "replaced" };

/** The one place a draft card's server state and the person's own gesture meet. */
export function draftCardView(card: DraftCard, local: DraftLocal): DraftCardView {
  if (local.pending === "discard") return { kind: "discarded", undo: true };
  if (local.pending === "discarding") return { kind: "discarded", undo: false };
  const state = askDraftState(card);
  switch (state) {
    case "sent":
      return { kind: "sent", at: card.draft.sent?.at ?? "" };
    case "discarded":
      return { kind: "discarded", undo: false };
    case "replaced":
      return { kind: "replaced" };
    case "sending":
      return { kind: "open", readOnly: !local.owner, sending: true, status: null };
    case "pending":
    case "not_sent": {
      const sending = local.pending === "send";
      if (!sending && !local.canAnswer) return { kind: "inactive" };
      const readOnly = !local.owner;
      if (sending) return { kind: "open", readOnly, sending, status: null };
      const failure = card.draft.failure;
      if (failure) return { kind: "open", readOnly, sending, status: "not_sent", failure };
      return { kind: "open", readOnly, sending, status: readOnly ? null : editStatus(local) };
    }
  }
}

function editStatus(local: DraftLocal): "editing" | "edited" | null {
  if (local.focused) return "editing";
  return local.edited ? "edited" : null;
}

/**
 * The card's main action: Send, Try again after a failure, and Reconnect first when the app is
 * disconnected, since sending again before reconnecting can only fail the same way.
 */
export function draftPrimaryAction(
  failure: AskDraft["failure"],
  reconnectOpened: boolean,
): "send" | "try_again" | "reconnect" {
  if (!failure) return "send";
  return failure.disconnected && !reconnectOpened ? "reconnect" : "try_again";
}

/** Every address of one role, in the order the bot gave them, or every address without a role. */
export function draftAddresses(draft: AskDraft, role?: AskDraft["recipients"][number]["role"]) {
  return draft.recipients
    .filter((recipient) => !role || recipient.role === role)
    .map((recipient) => recipient.address)
    .join(", ");
}

/** Who a sent draft's line names: its To recipients, or everyone when it had no To. */
export function draftSentTo(draft: AskDraft): string {
  return draftAddresses(draft, "to") || draftAddresses(draft);
}
