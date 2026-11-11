import type { AdapterContext } from "@tangow/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { decideWithin } from "./decision.js";
import {
  createDecisionProvider,
  prepareDecisionProviderConnection,
  SpaceDecisionProviderResolver,
} from "./decision-provider-factory.js";
import {
  documentedDecisionRequest,
  documentedWireBody,
  loadOpenRouterDecisionFixture,
} from "./fixtures/openrouter-decision-example.js";
import {
  OPENROUTER_DEFAULT_DECISION_MODEL,
  OpenRouterDecisionHttpError,
  OpenRouterDecisionProvider,
  openRouterDecisionRequiresDeploymentOwner,
  parseOpenRouterDecisionConnection,
} from "./openrouter-decision.js";

const fixture = loadOpenRouterDecisionFixture();

const connection = {
  apiKey: "test-key-not-real",
  baseUrl: "https://openrouter.ai",
  modelId: OPENROUTER_DEFAULT_DECISION_MODEL,
};

function contextWith(signal: AbortSignal = new AbortController().signal): AdapterContext {
  return { operationId: "op", traceId: "trace", spaceId: "space", userId: "user", signal };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noulRequest = {
  state: "x",
  questions: { signin: { type: "noul" as const, instructions: "Sign-in?" } },
};

describe("OpenRouter decision adapter", () => {
  it("sends the documented request and maps the documented response", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse(fixture.response),
    );
    const provider = new OpenRouterDecisionProvider(connection, {
      fetch: fetchMock as typeof fetch,
    });
    const response = await provider.decide(documentedDecisionRequest(fixture), contextWith());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key-not-real");
    expect(JSON.parse(String(init?.body))).toEqual(documentedWireBody(fixture));
    // Documented values, field for field; `legend`, `id`, `provider`, output tokens are dropped.
    expect(response).toEqual({
      model: "typesafe/jev-1.13-20260917",
      usage: { inputTokens: 476, cost: 1.9992e-5 },
      answers: {
        is_bug: { type: "noul", probability: 0.96 },
        team: {
          type: "choice",
          choice: "payments",
          confidence: 0.75,
          probabilities: { account: 0, frontend: 0.16, payments: 0.84 },
        },
        urgency: {
          type: "score",
          score: 1.99,
          confidence: 0.99,
          probabilities: { "0": 0, "1": 0.01, "2": 0.99 },
        },
      },
    });
  });

  it("passes the documented response through decideWithin validation", async () => {
    const provider = new OpenRouterDecisionProvider(connection, {
      fetch: (async () => jsonResponse(fixture.response)) as typeof fetch,
    });
    const result = await decideWithin(provider, documentedDecisionRequest(fixture), contextWith(), {
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({ ok: true, answers: { team: { choice: "payments" } } });
  });

  it.each(["401", "429", "502"])(
    "never retries and reports only the error class on documented %s",
    async (status) => {
      const fetchMock = vi.fn(async () => jsonResponse(fixture.errors[status], Number(status)));
      const provider = new OpenRouterDecisionProvider(connection, {
        fetch: fetchMock as typeof fetch,
      });
      const error = await provider.decide(noulRequest, contextWith()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpenRouterDecisionHttpError);
      expect((error as OpenRouterDecisionHttpError).status).toBe(Number(status));
      expect(String((error as Error).message)).not.toMatch(/openrouter\.ai|limit|credentials/i);
      const result = await decideWithin(provider, noulRequest, contextWith(), {
        timeoutMs: 1_000,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ ok: false, reason: "error", error: "OpenRouterDecisionHttpError" });
    },
  );

  it("reports a non-JSON body by class only", async () => {
    const provider = new OpenRouterDecisionProvider(connection, {
      fetch: (async () => new Response("<html>", { status: 200 })) as typeof fetch,
    });
    expect(await decideWithin(provider, noulRequest, contextWith(), { timeoutMs: 1_000 })).toEqual({
      ok: false,
      reason: "error",
      error: "OpenRouterDecisionResponseError",
    });
  });

  it("turns an answer missing documented fields into invalid_answer", async () => {
    const provider = new OpenRouterDecisionProvider(connection, {
      fetch: (async () =>
        jsonResponse({
          model: "typesafe/jev-1.13",
          answers: { team: { type: "choice", choice: "payments" } },
          usage: { input_tokens: 1, output_tokens: 0 },
        })) as typeof fetch,
    });
    const request = documentedDecisionRequest(fixture);
    const result = await decideWithin(
      provider,
      { ...request, questions: { team: request.questions.team! } },
      contextWith(),
      { timeoutMs: 1_000 },
    );
    expect(result).toEqual({ ok: false, reason: "invalid_answer" });
  });

  it("sends no request once the run signal is aborted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const provider = new OpenRouterDecisionProvider(connection, {
      fetch: fetchMock as typeof fetch,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.decide(noulRequest, contextWith(controller.signal)),
    ).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates the signal to the request", async () => {
    let seen: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const provider = new OpenRouterDecisionProvider(connection, {
      fetch: fetchMock as typeof fetch,
    });
    const controller = new AbortController();
    const pending = decideWithin(provider, noulRequest, contextWith(controller.signal), {
      timeoutMs: 5_000,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    expect(seen?.aborted).toBe(true);
  });

  it("never builds a provider without a key", async () => {
    expect(() => parseOpenRouterDecisionConnection({}, {})).toThrow(/apiKey/);
    expect(() => createDecisionProvider("openrouter", {}, { apiKey: "  " })).toThrow(/apiKey/);
    await expect(
      prepareDecisionProviderConnection({ provider: "openrouter", settings: {}, credentials: {} }),
    ).rejects.toThrow(/apiKey/);
  });

  it("applies defaults in the adapter only and validates the base URL shape", async () => {
    expect(parseOpenRouterDecisionConnection({}, { apiKey: "k" })).toEqual({
      apiKey: "k",
      baseUrl: "https://openrouter.ai",
      modelId: "typesafe/jev-1.13",
    });
    expect(
      await prepareDecisionProviderConnection({
        provider: "openrouter",
        settings: { baseUrl: " ", modelId: "" },
        credentials: { apiKey: " k " },
      }),
    ).toEqual({ provider: "openrouter", settings: {}, credentials: { apiKey: "k" } });
    expect(
      await prepareDecisionProviderConnection({
        provider: "openrouter",
        settings: { baseUrl: "https://proxy.example.test/", modelId: "~typesafe/jev-latest" },
        credentials: { apiKey: "k" },
      }),
    ).toEqual({
      provider: "openrouter",
      settings: { baseUrl: "https://proxy.example.test", modelId: "~typesafe/jev-latest" },
      credentials: { apiKey: "k" },
    });
    for (const baseUrl of [
      "ftp://proxy.example.test",
      "https://user:pass@proxy.example.test",
      "https://proxy.example.test/?q=1",
      "http://169.254.169.254",
      "not a url",
    ]) {
      await expect(
        prepareDecisionProviderConnection({
          provider: "openrouter",
          settings: { baseUrl },
          credentials: { apiKey: "k" },
        }),
      ).rejects.toThrow(/baseUrl/);
    }
    await expect(
      prepareDecisionProviderConnection({ provider: "other", settings: {}, credentials: {} }),
    ).rejects.toThrow(/Unknown decision provider/);
  });

  it("keeps private endpoints with the deployment owner", () => {
    expect(openRouterDecisionRequiresDeploymentOwner({})).toBe(false);
    expect(
      openRouterDecisionRequiresDeploymentOwner({ baseUrl: "https://proxy.example.test" }),
    ).toBe(false);
    for (const baseUrl of [
      "http://localhost:8080",
      "https://127.0.0.1",
      "https://10.0.0.4",
      "https://[fd00::1]",
      "http://proxy.example.test",
    ]) {
      expect(openRouterDecisionRequiresDeploymentOwner({ baseUrl })).toBe(true);
    }
  });
});

function resolverFor(
  options: {
    provider?: string;
    baseUrl?: string;
    ownerUserId?: string | null;
    none?: boolean;
  } = {},
) {
  const prisma = {
    spaceDecisionConfig: {
      findUnique: vi.fn(async () =>
        options.none
          ? null
          : {
              userId: "config-author",
              provider: options.provider ?? "openrouter",
              settings: options.baseUrl ? { baseUrl: options.baseUrl } : {},
              secret: { id: "secret-1", ciphertext: "encrypted" },
            },
      ),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: options.ownerUserId ?? null })),
    },
  };
  const secrets = { load: vi.fn(() => JSON.stringify({ apiKey: "test-key-not-real" })) };
  return {
    resolver: new SpaceDecisionProviderResolver(prisma as never, secrets as never),
    secrets,
  };
}

describe("SpaceDecisionProviderResolver", () => {
  it("resolves nothing without a connection or for an unknown provider", async () => {
    const empty = resolverFor({ none: true });
    await expect(empty.resolver.resolve("space-1", "config-author")).resolves.toBeNull();
    const unknown = resolverFor({ provider: "unknown" });
    await expect(unknown.resolver.resolve("space-1", "config-author")).resolves.toBeNull();
    expect(unknown.secrets.load).not.toHaveBeenCalled();
  });

  it("resolves nothing for a Space member who did not set it up", async () => {
    const { resolver, secrets } = resolverFor();
    await expect(resolver.resolve("space-1", "space-member")).resolves.toBeNull();
    expect(secrets.load).not.toHaveBeenCalled();
  });

  it("builds the Space provider from stored credentials", async () => {
    const { resolver } = resolverFor();
    const provider = await resolver.resolve("space-1", "config-author");
    expect(provider?.describe()).toMatchObject({
      id: "openrouter",
      capabilities: { maxOptions: 255 },
    });
  });

  it.each([null, "another-user"])(
    "disables a private endpoint the deployment owner did not configure: %s",
    async (ownerUserId) => {
      const { resolver, secrets } = resolverFor({
        baseUrl: "http://127.0.0.1:9000",
        ownerUserId,
      });
      await expect(resolver.resolve("space-1", "config-author")).resolves.toBeNull();
      expect(secrets.load).not.toHaveBeenCalled();
    },
  );

  it("keeps a private endpoint configured by the deployment owner", async () => {
    const { resolver } = resolverFor({
      baseUrl: "http://127.0.0.1:9000",
      ownerUserId: "config-author",
    });
    await expect(resolver.resolve("space-1", "config-author")).resolves.not.toBeNull();
  });
});
