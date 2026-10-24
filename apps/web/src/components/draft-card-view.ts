import type { AskDraft } from "@rakazo/contracts";
import { askDraftState } from "@rakazo/contracts";

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
  /** A tap on its way: Send until the server takes it, Discard during its Undo window. */
  pending: "send" | "discard" | null;
  /** The card is the one its run waits on, so a tap reaches it. */
  canAnswer: boolean;
};

export type DraftCardView =
  | {
      kind: "open";
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
  const state = askDraftState(card);
  switch (state) {
    case "sent":
      return { kind: "sent", at: card.draft.sent?.at ?? "" };
    case "discarded":
      return { kind: "discarded", undo: false };
    case "replaced":
      return { kind: "replaced" };
    case "sending":
      return { kind: "open", sending: true, status: null };
    case "pending":
    case "not_sent": {
      const sending = local.pending === "send";
      if (!sending && !local.canAnswer) return { kind: "inactive" };
      if (sending) return { kind: "open", sending, status: null };
      const failure = card.draft.failure;
      if (failure) return { kind: "open", sending, status: "not_sent", failure };
      return { kind: "open", sending, status: editStatus(local) };
    }
  }
}

function editStatus(local: DraftLocal): "editing" | "edited" | null {
  if (local.focused) return "editing";
  return local.edited ? "edited" : null;
}
