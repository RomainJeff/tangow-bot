import { waitForModelOAuthCompletion } from "@tangow/core";
import { rpc } from "./rpc";

export type { ModelCatalogEntry, ModelCredential, ModelOAuthBegin } from "@tangow/contracts";
export { cancelModelOAuthAttempt, finishModelOAuthAttempt } from "@tangow/core";

export async function waitForModelOAuth(loginId: string, signal?: AbortSignal) {
  return waitForModelOAuthCompletion(() => rpc.models.completeOAuth({ loginId }, { signal }), {
    signal,
  });
}
