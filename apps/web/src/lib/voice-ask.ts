import type { ThreadMessage } from "@rakazo/contracts";
import { isApprovalAskBlock, spokenDecision } from "@rakazo/core";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

/**
 * A multi-question `ask_user` v2 block expects one structured JSON answer
 * covering every question at once; a voice call can only send what it heard
 * as a single sentence, which the server always rejects for that shape. Every
 * other ask (approval, free-form, single-choice) takes a plain string answer,
 * which a spoken sentence already is.
 */
export function canAnswerAskByVoice(block: AskBlock): boolean {
  return !block.questions?.length;
}

/**
 * An approval card that carries a `detail` (what will be created, in full) can
 * only be read on screen: the call speaks the question alone, so it never
 * offers to approve it. The person approves in the thread, where the detail is.
 */
export function isDetailApproval(block: AskBlock): boolean {
  return isApprovalAskBlock(block) && Boolean(block.detail);
}

/** The actions the call offers for an ask: only `deny` for a detailed approval. */
export function callAskActions(block: AskBlock): NonNullable<AskBlock["actions"]> {
  const actions = block.actions ?? [];
  return isDetailApproval(block) ? actions.filter((action) => action.id === "deny") : actions;
}

/**
 * What a spoken sentence answers, or null to ignore it. A detailed approval
 * takes a spoken refusal only, as the `deny` action; nothing said can approve it.
 */
export function spokenAskAnswer(block: AskBlock, transcript: string): string | null {
  const decision = spokenDecision(transcript);
  if (isDetailApproval(block)) return decision === "no" ? "deny" : null;
  return decision ?? transcript;
}
