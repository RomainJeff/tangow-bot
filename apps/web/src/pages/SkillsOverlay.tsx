import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { AgentSkills } from "./KnowledgeSection";

/** Runtime ceiling: the agent only sees the first 50 visible skills. */
const SKILL_LIMIT = 50;

/**
 * Space-level skills section of the Customize dialog, which owns the shell.
 */
export function SkillsOverlay({
  botId,
  onSkillsChanged,
}: {
  botId?: string;
  onSkillsChanged?: () => void;
}) {
  const { t } = useLingui();
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadCatalog() {
    setVisibleCount((await rpc.agentSkills.list({ botId })).length);
  }

  useEffect(() => {
    void loadCatalog().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : t`Could not load skills`),
    );
  }, [botId]);

  function afterMutation() {
    onSkillsChanged?.();
    void loadCatalog().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : t`Could not load skills`),
    );
  }

  return (
    <>
      <div className="rk-scroll flex-1 overflow-y-auto px-8 py-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

        {visibleCount !== null && visibleCount > SKILL_LIMIT ? (
          <p className="mb-3 text-[13px] text-destructive">
            <Trans>Only the first 50 skills are shown to the agent.</Trans>
          </p>
        ) : null}
        <AgentSkills onChanged={afterMutation} />
      </div>
    </>
  );
}
