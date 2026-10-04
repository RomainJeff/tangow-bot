import type {
  AssistantMessageEventStream,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Models,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentModelOAuthCredential } from "@rakazo/adapter-kit";

export function toOAuthCredential(value: AgentModelOAuthCredential): OAuthCredential {
  return { ...value, type: "oauth" };
}

/**
 * Request-scoped Pi store for one already-authorized provider. Pi's default
 * in-memory store cannot see Rakazo's encrypted database; refreshes are
 * serialized here and published back for encryption.
 */
export class PiRuntimeCredentialStore implements CredentialStore {
  private credential?: Credential;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly providerId: string,
    credential?: Credential,
    private readonly persistOAuth?: (credential: OAuthCredential) => Promise<void>,
    private readonly reloadOAuth?: (
      rejected: OAuthCredential,
      signal: AbortSignal,
    ) => Promise<AgentModelOAuthCredential>,
  ) {
    this.credential = credential;
  }

  /**
   * Swap a credential the provider rejected for the stored one, which the serialized refresh
   * rotates only when no other run already has. False when there is nothing to reload.
   */
  reload(rejected: Credential, signal: AbortSignal): Promise<boolean> {
    const reloadOAuth = this.reloadOAuth;
    if (!reloadOAuth || rejected.type !== "oauth") return Promise.resolve(false);
    const operation = this.chain.then(async () => {
      // A concurrent call already replaced it; that one is the stored credential.
      if (this.credential !== rejected) return true;
      this.credential = toOAuthCredential(await reloadOAuth(rejected, signal));
      return true;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return providerId === this.providerId ? this.credential : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return this.credential ? [{ providerId: this.providerId, type: this.credential.type }] : [];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== this.providerId) return Promise.resolve(undefined);
    const previous = this.chain;
    const operation = previous.then(async () => {
      options?.signal?.throwIfAborted();
      const current = this.credential;
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        if (next.type === "oauth" && next !== current) {
          await this.persistOAuth?.(next);
        }
        this.credential = next;
      }
      return this.credential;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (providerId !== this.providerId) return Promise.resolve();
    const previous = this.chain;
    const operation = previous.then(() => {
      options?.signal?.throwIfAborted();
      this.credential = undefined;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}

const AUTH_FAILURE =
  /^401\b|authentication_error|token (?:has been |is )?(?:revoked|expired|invalidated)/i;

/**
 * Another run can rotate a subscription token between two model calls, which revokes the one
 * this run holds. A call refused for authentication before any output reloads the stored
 * credential and runs once more; a second refusal surfaces as it is.
 */
export function retryRejectedOAuth(
  models: Models,
  store: PiRuntimeCredentialStore,
  providerId: string,
): Models {
  const streamSimple = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      // An aborted read must not leave the outer stream unterminated; the call then runs once.
      const used = await store.read(providerId).catch(() => undefined);
      const first = streamSimple(model, context, options);
      let started = false;
      for await (const event of first) {
        if (
          !started &&
          used &&
          event.type === "error" &&
          event.reason === "error" &&
          AUTH_FAILURE.test(event.error.errorMessage ?? "") &&
          (await store
            .reload(used, options?.signal ?? new AbortController().signal)
            .catch(() => false))
        ) {
          return forward(outer, streamSimple(model, context, options));
        }
        started = true;
        outer.push(event);
      }
      outer.end(await first.result());
    })();
    return outer;
  };
  return models;
}

async function forward(target: AssistantMessageEventStream, source: AssistantMessageEventStream) {
  for await (const event of source) target.push(event);
  target.end(await source.result());
}
