import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";

/**
 * The skills the composer's `/` picker offers to the active bot. Only the most
 * recently requested list lands: a read that started before a skill write must
 * not put the old catalog back after the refresh that write asked for.
 */
export function useAgentSkillCatalog(
  activeBotId: RefObject<string | undefined>,
): [AgentSkillCatalogEntry[], () => void] {
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const latest = useRef(0);
  const refresh = useCallback(() => {
    const request = ++latest.current;
    void rpc.agentSkills
      .list({ botId: activeBotId.current })
      .then((list) => {
        if (request === latest.current) setSkills(list);
      })
      .catch(() => undefined);
  }, [activeBotId]);
  useEffect(() => refresh(), [refresh]);
  return [skills, refresh];
}
