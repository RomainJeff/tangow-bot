import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { decideWithin } from "./decision.js";
import {
  createDecisionProvider,
  prepareDecisionProviderConnection,
  SpaceDecisionProviderResolver,
} from "./decision-provider-factory.js";
import {
  parseTypeSafeDecisionConnection,
  TYPESAFE_DEFAULT_DECISION_MODEL,
  TypeSafeDecisionProvider,
  typesafeDecisionRequiresDeploymentOwner,
} from "./typesafe-decision.js";

const connection = {
  apiKey: "test-key-not-real",
  baseUrl: "https://decision.example.test",
  modelId: "jev-1.13.0",
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

describe("TypeSafe decision adapter", () => {
  it("translates questions and answers both ways", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
      jsonResponse({
        model: "jev-1.13.0",
        answers: {
          target: {
            type: "choice",
            choice: "e2",
            confidence: 0.8,
            probabilities: { e1: 0.2, e2: 0.8 },
          },
          signin: { type: "noul", noul: 0.3 },
          sure: {
            type: "score",
            score: 1,
            confidence: 0.6,
            legend: { 0: "no", 1: "yes" },
            probabilities: { 0: 0.4, 1: 0.6 },
          },
        },
        usage: { input_tokens: 42, output_tokens: 0 },
      }),
    );
    const provider = new TypeSafeDecisionProvider(connection, { fetch: fetchMock as typeof fetch });
    const response = await provider.decide(
      {
        state: { page: { title: "Reports" } },
        questions: {
          target: { type: "choice", instructions: "Which?", options: { e1: "a", e2: "b" } },
          signin: { type: "noul", instructions: "Sign-in?" },
          sure: { type: "score", instructions: "Settled?", levels: ["no", "yes"] },
        },
      },
      contextWith(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://decision.example.test/v1/systemone");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key-not-real");
    expect(JSON.parse(String(init?.body))).toEqual({
      state: { page: { title: "Reports" } },
      model: "jev-1.13.0",
      questions: {
        target: { type: "choice", instructions: "Which?", criteria: { e1: "a", e2: "b" } },
        signin: { type: "noul", instructions: "Sign-in?" },
        sure: { type: "score", instructions: "Settled?", criteria: ["no", "yes"] },
      },
    });
    expect(response).toEqual({
      model: "jev-1.13.0",
      usage: { inputTokens: 42 },
      answers: {
        target: {
          type: "choice",
          choice: "e2",
          confidence: 0.8,
          probabilities: { e1: 0.2, e2: 0.8 },
        },
        signin: { type: "noul", probability: 0.3 },
        sure: { type: "score", score: 1, confidence: 0.6, probabilities: { 0: 0.4, 1: 0.6 } },
      },
    });
  });

  it("never retries and reports only the SDK error class", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: "boom at https://decision.example.test/internal" }, 500),
    );
    const provider = new TypeSafeDecisionProvider(connection, { fetch: fetchMock as typeof fetch });
    const result = await decideWithin(
      provider,
      {
        state: "x",
        questions: { signin: { type: "noul", instructions: "Sign-in?" } },
      },
      contextWith(),
      { timeoutMs: 1_000 },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: "error", error: "InternalServerError" });
  });

  it("sends no request once the run signal is aborted", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const provider = new TypeSafeDecisionProvider(connection, { fetch: fetchMock as typeof fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.decide(
        { state: "x", questions: { signin: { type: "noul", instructions: "?" } } },
        contextWith(controller.signal),
      ),
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
    const provider = new TypeSafeDecisionProvider(connection, { fetch: fetchMock as typeof fetch });
    const controller = new AbortController();
    const pending = decideWithin(
      provider,
      { state: "x", questions: { signin: { type: "noul", instructions: "?" } } },
      contextWith(controller.signal),
      { timeoutMs: 5_000 },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    expect(seen?.aborted).toBe(true);
  });

  it("never builds a client without a key", async () => {
    expect(() => parseTypeSafeDecisionConnection({}, {})).toThrow(/apiKey/);
    expect(() => createDecisionProvider("typesafe", {}, { apiKey: "  " })).toThrow(/apiKey/);
    await expect(
      prepareDecisionProviderConnection({ provider: "typesafe", settings: {}, credentials: {} }),
    ).rejects.toThrow(/apiKey/);
  });

  it("applies defaults in the adapter only and validates the base URL shape", async () => {
    expect(parseTypeSafeDecisionConnection({}, { apiKey: "k" })).toEqual({
      apiKey: "k",
      baseUrl: "https://api.typesafe.ai",
      modelId: TYPESAFE_DEFAULT_DECISION_MODEL,
    });
    expect(
      await prepareDecisionProviderConnection({
        provider: "typesafe",
        settings: { baseUrl: " ", modelId: "" },
        credentials: { apiKey: " k " },
      }),
    ).toEqual({ provider: "typesafe", settings: {}, credentials: { apiKey: "k" } });
    expect(
      await prepareDecisionProviderConnection({
        provider: "typesafe",
        settings: { baseUrl: "https://proxy.example.test/", modelId: "jev-1.14.0" },
        credentials: { apiKey: "k" },
      }),
    ).toEqual({
      provider: "typesafe",
      settings: { baseUrl: "https://proxy.example.test", modelId: "jev-1.14.0" },
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
          provider: "typesafe",
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
    expect(typesafeDecisionRequiresDeploymentOwner({})).toBe(false);
    expect(typesafeDecisionRequiresDeploymentOwner({ baseUrl: "https://proxy.example.test" })).toBe(
      false,
    );
    for (const baseUrl of [
      "http://localhost:8080",
      "https://127.0.0.1",
      "https://10.0.0.4",
      "https://[fd00::1]",
      "http://proxy.example.test",
    ]) {
      expect(typesafeDecisionRequiresDeploymentOwner({ baseUrl })).toBe(true);
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
              provider: options.provider ?? "typesafe",
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
    await expect(empty.resolver.resolve("space-1")).resolves.toBeNull();
    const unknown = resolverFor({ provider: "retired" });
    await expect(unknown.resolver.resolve("space-1")).resolves.toBeNull();
    expect(unknown.secrets.load).not.toHaveBeenCalled();
  });

  it("builds the Space provider from stored credentials", async () => {
    const { resolver } = resolverFor();
    const provider = await resolver.resolve("space-1");
    expect(provider?.describe()).toMatchObject({
      id: "typesafe",
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
      await expect(resolver.resolve("space-1")).resolves.toBeNull();
      expect(secrets.load).not.toHaveBeenCalled();
    },
  );

  it("keeps a private endpoint configured by the deployment owner", async () => {
    const { resolver } = resolverFor({
      baseUrl: "http://127.0.0.1:9000",
      ownerUserId: "config-author",
    });
    await expect(resolver.resolve("space-1")).resolves.not.toBeNull();
  });
});
