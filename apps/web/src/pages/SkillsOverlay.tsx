import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry, SpaceMarketplace } from "@rakazo/contracts";
import { Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { AgentSkills } from "./KnowledgeSection";
import { BrowseTab } from "./skills/browse-tab";
import { errorMessage } from "./skills/error-message";
import { MarketplacesTab } from "./skills/marketplaces-tab";

/** Runtime ceiling: the agent only sees the first 50 visible skills. */
const SKILL_LIMIT = 50;

type SkillsTab = "installed" | "marketplaces" | "browse";

/**
 * Space-level skills panel: the existing per-bot skill manager (Installed),
 * GitHub marketplaces (Marketplaces) and their plugins (Browse). Rendered as a
 * section of the Customize dialog, which owns the shell.
 */
export function SkillsOverlay({
  botId,
  onSkillsChanged,
}: {
  botId?: string;
  onSkillsChanged?: () => void;
}) {
  const { t } = useLingui();
  const [tab, setTab] = useState<SkillsTab>("installed");
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<AgentSkillCatalogEntry[]>([]);
  const [marketplaces, setMarketplaces] = useState<SpaceMarketplace[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadCatalog() {
    const [visible, all] = await Promise.all([
      rpc.agentSkills.list({ botId }),
      rpc.agentSkills.list(),
    ]);
    setVisibleCount(visible.length);
    setCatalog(all);
  }

  async function loadMarketplaces() {
    setMarketplaces(await rpc.marketplaces.list({}));
  }

  // ponytail: refetch on every tab switch so the counter follows edits made in Installed.
  useEffect(() => {
    void Promise.all([loadCatalog(), loadMarketplaces()]).catch((err: unknown) =>
      setError(errorMessage(err, t`Could not load skills`)),
    );
  }, [tab, botId]);

  async function afterMutation() {
    onSkillsChanged?.();
    await Promise.all([loadCatalog(), loadMarketplaces()]);
  }

  return (
    <>
      <div className="px-8 pt-4">
        <Tabs value={tab} onValueChange={(value) => setTab(value as SkillsTab)}>
          <TabsList className="w-full">
            <TabsTrigger value="installed" data-testid="skills-tab-installed">
              <Trans>Installed</Trans>
            </TabsTrigger>
            <TabsTrigger value="marketplaces" data-testid="skills-tab-marketplaces">
              <Trans>Marketplaces</Trans>
            </TabsTrigger>
            <TabsTrigger value="browse" data-testid="skills-tab-browse">
              <Trans>Browse</Trans>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="rk-scroll flex-1 overflow-y-auto px-8 py-6">
        {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}

        {tab === "installed" ? (
          <>
            {visibleCount !== null && visibleCount > SKILL_LIMIT ? (
              <p className="mb-3 text-[13px] text-destructive">
                <Trans>Only the first 50 skills are shown to the agent.</Trans>
              </p>
            ) : null}
            <AgentSkills onChanged={onSkillsChanged} />
          </>
        ) : null}

        {tab === "marketplaces" ? (
          <MarketplacesTab
            marketplaces={marketplaces}
            onChanged={afterMutation}
            onError={setError}
          />
        ) : null}

        {tab === "browse" ? (
          <BrowseTab
            marketplaces={marketplaces}
            catalog={catalog}
            onChanged={afterMutation}
            onError={setError}
          />
        ) : null}
      </div>
    </>
  );
}
