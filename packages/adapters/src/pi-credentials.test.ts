import type { Api, AssistantMessage, Model, Models, OAuthCredential } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import { PiRuntimeCredentialStore, retryRejectedOAuth } from "./pi-credentials.js";

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60 * 60_000,
    ...overrides,
  };
}

describe("PiRuntimeCredentialStore", () => {
  it("does not configure openai-codex without a stored OAuth credential", async () => {
    expect(await builtinModels().getAuth("openai-codex")).toBeUndefined();
  });

  it("bridges an encrypted OAuth credential into the OAuth-only Codex provider", async () => {
    const store = new PiRuntimeCredentialStore("openai-codex", credential());
    const models = builtinModels({ credentials: store });

    const auth = await models.getAuth("openai-codex");

    expect(auth?.auth.apiKey).toBe("access-token");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });

  it("serializes refresh publication without exposing credential values in metadata", async () => {
    let persisted: OAuthCredential | undefined;
    const store = new PiRuntimeCredentialStore(
      "openai-codex",
      credential({ access: "old-access" }),
      async (next) => {
        persisted = next;
      },
    );

    await store.modify("openai-codex", async () => credential({ access: "new-access" }));

    expect(persisted?.access).toBe("new-access");
    expect(await store.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });
});

const REVOKED =
  '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}';

function reply(stopReason: "stop" | "error", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: stopReason === "stop" ? [{ type: "text", text: "hello" }] : [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 0,
  };
}

/** A provider that, like Pi, reads the stored credential per call and refuses revoked tokens. */
function subscriptionModels(store: PiRuntimeCredentialStore, revoked: Set<string>) {
  const tokens: string[] = [];
  const models = {
    streamSimple: () => {
      const stream = createAssistantMessageEventStream();
      void store.read("anthropic").then((current) => {
        const token = current?.type === "oauth" ? current.access : "";
        tokens.push(token);
        if (revoked.has(token)) {
          const error = reply("error", REVOKED);
          stream.push({ type: "error", reason: "error", error });
          stream.end(error);
          return;
        }
        const message = reply("stop");
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  } as unknown as Models;
  return { models, tokens };
}

describe("retryRejectedOAuth", () => {
  const model = { provider: "anthropic", api: "anthropic-messages" } as Model<Api>;

  it("retries once with the stored credential another run rotated", async () => {
    const reload = vi.fn(async (_rejected: OAuthCredential) =>
      credential({ access: "rotated-access" }),
    );
    const store = new PiRuntimeCredentialStore(
      "anthropic",
      credential({ access: "old-access" }),
      undefined,
      reload,
    );
    const { models, tokens } = subscriptionModels(store, new Set(["old-access"]));

    const result = await retryRejectedOAuth(models, store, "anthropic")
      .streamSimple(model, { messages: [] })
      .result();

    expect(result.stopReason).toBe("stop");
    expect(tokens).toEqual(["old-access", "rotated-access"]);
    expect(reload).toHaveBeenCalledOnce();
    expect(reload.mock.calls[0]?.[0]).toMatchObject({ access: "old-access" });
  });

  it("surfaces a second authentication failure without retrying again", async () => {
    const reload = vi.fn(async (_rejected: OAuthCredential) =>
      credential({ access: "rotated-access" }),
    );
    const store = new PiRuntimeCredentialStore(
      "anthropic",
      credential({ access: "old-access" }),
      undefined,
      reload,
    );
    const { models, tokens } = subscriptionModels(store, new Set(["old-access", "rotated-access"]));

    const result = await retryRejectedOAuth(models, store, "anthropic")
      .streamSimple(model, { messages: [] })
      .result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(REVOKED);
    expect(tokens).toEqual(["old-access", "rotated-access"]);
    expect(reload).toHaveBeenCalledOnce();
  });
});
