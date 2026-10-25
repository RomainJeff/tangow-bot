import type { AgentRunModel, AgentRuntimeEvent, GuestModel } from "@rakazo/adapter-kit";

export type RelayUsage = Extract<AgentRuntimeEvent, { type: "usage" }>;

/** Whose call this is, by the controller's ids: a helper is named by the ref the controller gave it. */
export type RelayConversation = { threadId: string; botId: string; helper?: string };

/**
 * Controller half of a model-access dialect: run one guest model call with the controller's model,
 * key and session, stream the dialect's events through `send`, and resolve with the usage the
 * provider reported. The guest shapes only the transcript. Caps, abort, redaction and accounting
 * stay with the caller, the same for every dialect.
 */
export type ModelRelay<Call, Event> = (
  model: AgentRunModel,
  call: Call,
  send: (event: Event) => void,
  options: { signal: AbortSignal; conversation: RelayConversation },
) => Promise<RelayUsage | undefined>;

/** What the guest may know of a model, field by field: never a key, endpoint or credential. */
export function guestModelOf(model: AgentRunModel): GuestModel {
  return {
    provider: model.provider,
    id: model.id,
    reasoning: model.reasoning,
    acceptsImages: model.acceptsImages,
    maxImagesPerPrompt: model.maxImagesPerPrompt,
    maxTokens: model.maxTokens,
    contextWindow: model.contextWindow,
    thinkingLevel: model.thinkingLevel,
  };
}
