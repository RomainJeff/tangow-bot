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
 * A Create bot card carries instructions and a first message, and a routine card the
 * instruction the routine will follow, and a mail draft the text that leaves in the person's
 * name, that must be read before approving, so the call never offers to approve them. The person
 * approves in the thread, where the full card is.
 */
export function isScreenOnlyApproval(block: AskBlock): boolean {
  return (
    isApprovalAskBlock(block) &&
    Boolean(block.spawnBot || block.proposal || block.routine || block.draft)
  );
}

/** The actions the call offers for an ask: only `deny` for a screen-only approval. */
export function callAskActions(block: AskBlock): NonNullable<AskBlock["actions"]> {
  const actions = block.actions ?? [];
  return isScreenOnlyApproval(block) ? actions.filter((action) => action.id === "deny") : actions;
}

/**
 * What a spoken sentence answers, or null when it cannot answer. A screen-only
 * approval takes a spoken refusal only, as the `deny` action; nothing said can approve it.
 */
export function spokenAskAnswer(block: AskBlock, transcript: string): string | null {
  const decision = spokenDecision(transcript);
  if (isScreenOnlyApproval(block)) return decision === "no" ? "deny" : null;
  return decision ?? transcript;
}
