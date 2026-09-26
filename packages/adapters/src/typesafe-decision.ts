import { isIP } from "node:net";
import type {
  AdapterContext,
  AdapterDescriptor,
  DecisionAnswer,
  DecisionCapabilities,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
} from "@rakazo/adapter-kit";
import { isLocalMcpHost } from "@rakazo/contracts";
import type { EntryType, Question, Questions, ScoreCriteria } from "@typesafe-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { isCloudMetadataAddress, isPrivateAddress } from "./network-address.js";
import { isBlockedHostname } from "./web-ssrf.js";

export const TYPESAFE_DECISION_PROVIDER_ID = "typesafe";
export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
/** Pinned: a moving alias would silently invalidate the calibrated confidence threshold. */
export const TYPESAFE_DEFAULT_DECISION_MODEL = "jev-1.13.0";
/** Documented option limit of one `choice` question. */
export const TYPESAFE_DECISION_MAX_OPTIONS = 255;

export interface TypeSafeDecisionConnection {
  apiKey: string;
  baseUrl: string;
  modelId: string;
}

function parseBaseUrl(value: string | undefined): URL | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("baseUrl must be a valid HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("baseUrl must use HTTP(S) without credentials, a query, or a fragment");
  }
  if (isCloudMetadataAddress(hostnameOf(url))) {
    throw new Error("baseUrl targets a blocked address");
  }
  return url;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

export function parseTypeSafeDecisionConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): TypeSafeDecisionConnection {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) throw new Error("apiKey is required");
  const baseUrl = parseBaseUrl(settings.baseUrl);
  return {
    apiKey,
    baseUrl: baseUrl ? baseUrl.href.replace(/\/+$/, "") : TYPESAFE_DEFAULT_BASE_URL,
    modelId: settings.modelId?.trim() || TYPESAFE_DEFAULT_DECISION_MODEL,
  };
}

/** Loopback, private literals, LAN names, or cleartext HTTP stay with the deployment owner. */
export function typesafeDecisionRequiresDeploymentOwner(settings: Record<string, string>): boolean {
  let url: URL | undefined;
  try {
    url = parseBaseUrl(settings.baseUrl);
  } catch {
    return false;
  }
  if (!url) return false;
  const host = hostnameOf(url);
  if (isLocalMcpHost(host) || isBlockedHostname(host)) return true;
  if (isIP(host) !== 0 && isPrivateAddress(host)) return true;
  return url.protocol === "http:";
}

/** Validates shape only; no credentialed probe. Defaults stay implicit. */
export async function prepareTypeSafeDecisionConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const connection = parseTypeSafeDecisionConnection(settings, credentials);
  const prepared: Record<string, string> = {};
  if (settings.baseUrl?.trim()) prepared.baseUrl = connection.baseUrl;
  if (settings.modelId?.trim()) prepared.modelId = connection.modelId;
  return { settings: prepared, credentials: { apiKey: connection.apiKey } };
}

export function createTypeSafeDecisionProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): DecisionProvider {
  return new TypeSafeDecisionProvider(parseTypeSafeDecisionConnection(settings, credentials));
}

/**
 * Translates the neutral decision contract to TypeSafe System One. The only file
 * that imports the SDK. Every client option is explicit so the SDK never falls
 * back to its own environment variables; retries are off because `decideWithin`
 * owns the time budget.
 */
export class TypeSafeDecisionProvider implements DecisionProvider {
  private readonly client: TypeSafeClient;

  constructor(connection: TypeSafeDecisionConnection, options: { fetch?: typeof fetch } = {}) {
    this.client = new TypeSafeClient({
      apiKey: connection.apiKey,
      baseURL: connection.baseUrl,
      defaultModel: connection.modelId,
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: options.fetch,
    });
  }

  describe(): AdapterDescriptor<DecisionCapabilities> {
    return {
      id: TYPESAFE_DECISION_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        noul: true,
        choice: true,
        score: true,
        maxOptions: TYPESAFE_DECISION_MAX_OPTIONS,
        offline: false,
      },
    };
  }

  async decide(request: DecisionRequest, context: AdapterContext): Promise<DecisionResponse> {
    context.signal.throwIfAborted();
    const questions: Questions = Object.fromEntries(
      Object.entries(request.questions).map(([name, question]) => [name, toSdkQuestion(question)]),
    );
    const result = await this.client.systemOne(
      { state: request.state as EntryType, questions },
      { signal: context.signal, retry: { maxRetries: 0 } },
    );
    const answers: Record<string, DecisionAnswer> = {};
    for (const [name, answer] of Object.entries(result.answers)) {
      if (answer.type === "noul") answers[name] = { type: "noul", probability: answer.noul };
      else if (answer.type === "choice") {
        answers[name] = {
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: { ...answer.probabilities },
        };
      } else {
        answers[name] = {
          type: "score",
          score: answer.score,
          confidence: answer.confidence,
          probabilities: { ...(answer.probabilities as Record<string, number>) },
        };
      }
    }
    const inputTokens = result.usage?.input_tokens;
    return {
      answers,
      ...(typeof result.model === "string" ? { model: result.model } : {}),
      ...(typeof inputTokens === "number" ? { usage: { inputTokens } } : {}),
    };
  }
}

function toSdkQuestion(question: DecisionQuestion): Question {
  if (question.type === "noul") return { type: "noul", instructions: question.instructions };
  if (question.type === "choice") {
    return { type: "choice", instructions: question.instructions, criteria: question.options };
  }
  return {
    type: "score",
    instructions: question.instructions,
    criteria: question.levels as unknown as ScoreCriteria,
  };
}
