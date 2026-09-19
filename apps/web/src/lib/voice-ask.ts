import type { ThreadMessage } from "@rakazo/contracts";

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
