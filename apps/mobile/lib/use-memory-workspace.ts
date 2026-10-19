import type { SpaceNavigation } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import type { ApiRequestContext } from "./api";
import { captureApiRequestContext, rpc } from "./api";

/** Pin memory reads to the workspace being browsed, without switching the conversation. */
export function useMemoryWorkspace(spaceId?: string) {
  const [result, setResult] = useState<{
    requestedId?: string;
    navigation: SpaceNavigation;
    requestContext: ApiRequestContext;
  } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setResult(null);
    setError(false);
    void (async () => {
      const context = await captureApiRequestContext();
      if (spaceId) context.headers["x-rakazo-space-id"] = spaceId;
      const navigation = await rpc<SpaceNavigation>("spaces/list", {}, { requestContext: context });
      context.headers["x-rakazo-space-id"] = navigation.current.id;
      if (active) setResult({ requestedId: spaceId, navigation, requestContext: context });
    })().catch(() => {
      if (active) setError(true);
    });
    return () => {
      active = false;
    };
  }, [spaceId]);
  return { workspace: result?.requestedId === spaceId ? result : null, error };
}
