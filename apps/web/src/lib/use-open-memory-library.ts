import type { MemoryCollectionKind } from "@rakazo/contracts";
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** Opens the Memory library and returns to the current screen on Back. */
export function useOpenMemoryLibrary() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  return useCallback(
    (collection: MemoryCollectionKind, params: { bot?: string; memory?: string } = {}) => {
      const query = new URLSearchParams({ collection });
      if (params.bot) query.set("bot", params.bot);
      if (params.memory) query.set("memory", params.memory);
      navigate(`/app/memory?${query}`, { state: { returnTo: pathname + search } });
    },
    [navigate, pathname, search],
  );
}
