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
import { isCloudMetadataAddress, isPrivateAddress } from "./network-address.js";
import { isBlockedHostname } from "./web-ssrf.js";

export const OPENROUTER_DECISION_PROVIDER_ID = "openrouter";
export const OPENROUTER_DECISION_DEFAULT_BASE_URL = "https://openrouter.ai";
/** OpenRouter Decisions API (alpha); served outside `/api/v1`. */
export const OPENROUTER_DECISION_PATH = "/api/alpha/decisions";
/**
 * Versioned id, not the `~typesafe/jev-latest` alias: a moving alias would silently
 * invalidate the calibrated confidence threshold.
 */
export const OPENROUTER_DEFAULT_DECISION_MODEL = "typesafe/jev-1.13";
/** Documented option limit of one `choice` question (TypeSafe API reference). */
export const OPENROUTER_DECISION_MAX_OPTIONS = 255;

export interface OpenRouterDecisionConnection {
  apiKey: string;
  baseUrl: string;
  modelId: string;
}

/** Carries the HTTP status only; never the URL or the response body. */
export class OpenRouterDecisionHttpError extends Error {
  constructor(readonly status: number) {
    super(`Decision request failed with status ${status}`);
    this.name = "OpenRouterDecisionHttpError";
  }
}

/** The response was not the documented JSON shape. */
export class OpenRouterDecisionResponseError extends Error {
  constructor() {
    super("Decision response was not valid JSON");
    this.name = "OpenRouterDecisionResponseError";
  }
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

export function parseOpenRouterDecisionConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): OpenRouterDecisionConnection {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) throw new Error("apiKey is required");
  const baseUrl = parseBaseUrl(settings.baseUrl);
  return {
    apiKey,
    baseUrl: baseUrl ? baseUrl.href.replace(/\/+$/, "") : OPENROUTER_DECISION_DEFAULT_BASE_URL,
    modelId: settings.modelId?.trim() || OPENROUTER_DEFAULT_DECISION_MODEL,
  };
}

/** Loopback, private literals, LAN names, or cleartext HTTP stay with the deployment owner. */
export function openRouterDecisionRequiresDeploymentOwner(
  settings: Record<string, string>,
): boolean {
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
export async function prepareOpenRouterDecisionConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const connection = parseOpenRouterDecisionConnection(settings, credentials);
  const prepared: Record<string, string> = {};
  if (settings.baseUrl?.trim()) prepared.baseUrl = connection.baseUrl;
  if (settings.modelId?.trim()) prepared.modelId = connection.modelId;
  return { settings: prepared, credentials: { apiKey: connection.apiKey } };
}

export function createOpenRouterDecisionProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): DecisionProvider {
  return new OpenRouterDecisionProvider(parseOpenRouterDecisionConnection(settings, credentials));
}

/**
 * Translates the neutral decision contract to the OpenRouter Decisions API
 * (`POST /api/alpha/decisions`, Jev by TypeSafe). Plain `fetch`, one attempt:
 * `decideWithin` owns the time budget, so there are no retries.
 */
export class OpenRouterDecisionProvider implements DecisionProvider {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly connection: OpenRouterDecisionConnection,
    options: { fetch?: typeof fetch } = {},
  ) {
    this.fetch = options.fetch ?? fetch;
  }

  describe(): AdapterDescriptor<DecisionCapabilities> {
    return {
      id: OPENROUTER_DECISION_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        noul: true,
        choice: true,
        score: true,
        maxOptions: OPENROUTER_DECISION_MAX_OPTIONS,
        offline: false,
      },
    };
  }

  async decide(request: DecisionRequest, context: AdapterContext): Promise<DecisionResponse> {
    context.signal.throwIfAborted();
    const response = await this.fetch(`${this.connection.baseUrl}${OPENROUTER_DECISION_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.connection.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.connection.modelId,
        state: request.state,
        questions: Object.fromEntries(
          Object.entries(request.questions).map(([name, question]) => [name, toWire(question)]),
        ),
      }),
      signal: context.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenRouterDecisionHttpError(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OpenRouterDecisionResponseError();
    }
    return fromWire(body);
  }
}

function toWire(question: DecisionQuestion): Record<string, unknown> {
  if (question.type === "noul") return { type: "noul", instructions: question.instructions };
  if (question.type === "choice") {
    return { type: "choice", instructions: question.instructions, criteria: question.options };
  }
  return { type: "score", instructions: question.instructions, criteria: question.levels };
}

type WireAnswer = {
  type?: unknown;
  noul?: unknown;
  choice?: unknown;
  score?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
};

/**
 * Copies documented fields only (`legend`, `id`, `provider` and `usage.cost` are
 * dropped). Nothing is invented: a missing field stays missing and `decideWithin`
 * turns it into `invalid_answer`.
 */
function fromWire(body: unknown): DecisionResponse {
  const wire = (body && typeof body === "object" ? body : {}) as {
    model?: unknown;
    answers?: unknown;
    usage?: { input_tokens?: unknown };
  };
  const answers: Record<string, DecisionAnswer> = {};
  const rawAnswers = wire.answers && typeof wire.answers === "object" ? wire.answers : {};
  for (const [name, raw] of Object.entries(rawAnswers as Record<string, WireAnswer>)) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type === "noul") {
      answers[name] = { type: "noul", probability: raw.noul as number };
    } else if (raw.type === "choice") {
      answers[name] = {
        type: "choice",
        choice: raw.choice as string,
        confidence: raw.confidence as number,
        probabilities: raw.probabilities as Record<string, number>,
      };
    } else if (raw.type === "score") {
      answers[name] = {
        type: "score",
        score: raw.score as number,
        confidence: raw.confidence as number,
        probabilities: raw.probabilities as Record<string, number>,
      };
    }
  }
  const inputTokens = wire.usage?.input_tokens;
  return {
    answers,
    ...(typeof wire.model === "string" ? { model: wire.model } : {}),
    ...(typeof inputTokens === "number" ? { usage: { inputTokens } } : {}),
  };
}
