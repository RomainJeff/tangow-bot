import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  MarketplacePlugin,
  SpaceMarketplace,
} from "@rakazo/contracts";
import { marketplaceSkillKey } from "@rakazo/core";
import { Badge, Button, Checkbox, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorMessage } from "./error-message";

/** Pending key for the batch install; not a valid plugin name, so it cannot collide with one. */
const BATCH = "\0batch";

export function BrowseTab({
  marketplaces,
  catalog,
  onChanged,
  onError,
}: {
  marketplaces: SpaceMarketplace[];
  catalog: AgentSkillCatalogEntry[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { t } = useLingui();
  const [selectedId, setSelectedId] = useState("");
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const marketplaceId = marketplaces.some((mkt) => mkt.id === selectedId)
    ? selectedId
    : (marketplaces[0]?.id ?? "");
  const marketplace = marketplaces.find((mkt) => mkt.id === marketplaceId);

  async function loadPlugins() {
    if (!marketplaceId) {
      setPicked(new Set());
      return setPlugins([]);
    }
    const next = await rpc.marketplaces.plugins({ marketplaceId });
    setPlugins(next);
    // ponytail: prune instead of clear, so a single-row install/remove keeps the other ticks.
    const selectable = new Set(next.filter((p) => !p.installed && p.supported).map((p) => p.name));
    setPicked((prev) => new Set([...prev].filter((name) => selectable.has(name))));
  }

  useEffect(() => {
    // Another marketplace can list the same plugin name: prune alone would keep the tick.
    setPicked(new Set());
    void loadPlugins().catch((err: unknown) =>
      onError(errorMessage(err, t`Could not load plugins`)),
    );
  }, [marketplaceId]);

  async function run(key: string, fallback: string, action: () => Promise<void>) {
    setPending(key);
    onError(null);
    try {
      await action();
      await Promise.all([onChanged(), loadPlugins()]);
    } catch (err) {
      onError(errorMessage(err, fallback));
    } finally {
      setPending(null);
    }
  }

  // ponytail: two install paths in the UI, one on the server (installPlugin = installPlugins([p])).
  function toggle(plugin: MarketplacePlugin) {
    if (!marketplace) return;
    void run(plugin.name, t`Could not update plugin`, async () => {
      const input = { marketplaceId: marketplace.id, plugin: plugin.name };
      await (plugin.installed
        ? rpc.marketplaces.removePlugin(input)
        : rpc.marketplaces.installPlugin(input));
    });
  }

  function installPicked() {
    if (!marketplace || picked.size === 0) return;
    void run(BATCH, t`Could not install skills`, async () => {
      await rpc.marketplaces.installPlugins({
        marketplaceId: marketplace.id,
        plugins: [...picked],
      });
    });
  }

  if (marketplaces.length === 0) {
    return (
      <p className="text-muted-foreground/80">
        <Trans>Add a marketplace first.</Trans>
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <NativeSelect
        className="w-full"
        value={marketplaceId}
        onChange={(event) => setSelectedId(event.target.value)}
        aria-label={t`Marketplace`}
      >
        {marketplaces.map((mkt) => (
          <NativeSelectOption key={mkt.id} value={mkt.id}>
            {mkt.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>

      {picked.size > 0 ? (
        <div
          role="status"
          className="sticky top-0 z-10 flex items-center justify-between rounded-xl border border-border bg-card px-4 py-2"
        >
          <span className="text-[13px] text-muted-foreground">
            <Trans>{picked.size} selected</Trans>
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={pending !== null}
            onClick={installPicked}
          >
            {pending === BATCH ? (
              <Trans>Installing…</Trans>
            ) : (
              <Trans>Install selected ({picked.size})</Trans>
            )}
          </Button>
        </div>
      ) : null}

      {plugins.length === 0 ? (
        <p className="text-muted-foreground/80">
          {marketplace?.kind === "skills" ? (
            <Trans>No skills in this marketplace.</Trans>
          ) : (
            <Trans>No plugins in this marketplace.</Trans>
          )}
        </p>
      ) : null}

      {plugins.map((plugin) => {
        const prefix = marketplace ? marketplaceSkillKey(marketplace.name, plugin.name, "") : "";
        const skills = plugin.installed ? catalog.filter((s) => s.id.startsWith(prefix)) : [];
        return (
          <div key={plugin.name} className="rounded-xl border border-border px-4 py-3">
            <div className="flex items-center gap-4">
              {!plugin.installed && plugin.supported ? (
                <Checkbox
                  aria-label={t`Select ${plugin.name}`}
                  checked={picked.has(plugin.name)}
                  onCheckedChange={(checked) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(plugin.name);
                      else next.delete(plugin.name);
                      return next;
                    })
                  }
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[15px] font-medium text-foreground">
                  {plugin.name}
                  {plugin.supported ? null : (
                    <Badge variant="outline">
                      <Trans>Unsupported source</Trans>
                    </Badge>
                  )}
                </div>
                {plugin.description ? (
                  <div className="text-[13px] text-muted-foreground/80">{plugin.description}</div>
                ) : null}
              </div>
              <Button
                type="button"
                variant="secondary"
                className="rounded-full"
                size="sm"
                disabled={pending !== null || (!plugin.supported && !plugin.installed)}
                onClick={() => toggle(plugin)}
              >
                {pending === plugin.name ? (
                  <Trans>Working…</Trans>
                ) : plugin.installed ? (
                  <Trans>Remove</Trans>
                ) : (
                  <Trans>Install</Trans>
                )}
              </Button>
            </div>
            {plugin.installed ? (
              <div className="mt-2 text-[13px]">
                {/* One plugin is one skill in a skills repository, so the sublist adds nothing. */}
                {marketplace?.kind !== "skills" && skills.length === 0 ? (
                  <p className="text-muted-foreground/80">
                    <Trans>No skills in this plugin.</Trans>
                  </p>
                ) : null}
                {marketplace?.kind !== "skills" && skills.length > 0 ? (
                  <ul className="list-disc ps-5 text-foreground">
                    {skills.map((skill) => (
                      <li key={skill.id}>
                        {skill.name}
                        {skill.description ? (
                          <span className="text-muted-foreground/80"> — {skill.description}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-1 text-muted-foreground/80">
                  <Trans>Off for every agent until you pick some in Installed.</Trans>
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
