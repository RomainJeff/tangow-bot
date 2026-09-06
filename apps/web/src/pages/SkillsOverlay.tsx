import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  MarketplaceFileChange,
  MarketplacePlugin,
  MarketplaceUpdateCheck,
  SpaceMarketplace,
} from "@rakazo/contracts";
import { marketplaceSkillKey } from "@rakazo/core";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatBytes } from "../components/ArtifactFileCard";
import { rpc } from "../lib/rpc";
import { AgentSkills } from "./KnowledgeSection";

/** Runtime ceiling: the agent only sees the first 50 visible skills. */
const SKILL_LIMIT = 50;

type SkillsTab = "installed" | "marketplaces" | "browse";

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Space-level skills panel: the existing per-bot skill manager (Installed),
 * GitHub marketplaces (Marketplaces) and their plugins (Browse).
 */
export function SkillsOverlay({
  onClose,
  botId,
  onSkillsChanged,
}: {
  onClose: () => void;
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl bg-card p-0 sm:max-w-[1080px]"
      >
        <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
          <DialogTitle className="text-2xl text-foreground">
            <Trans>Skills</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close skills`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>

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
              <div className="mb-3 flex items-baseline justify-between gap-3 text-[13px] text-muted-foreground">
                <span>
                  {visibleCount === null ? "…" : `${visibleCount} / ${SKILL_LIMIT}`}{" "}
                  <Trans>skills visible to this agent</Trans>
                </span>
                {visibleCount !== null && visibleCount > SKILL_LIMIT ? (
                  <span className="text-destructive">
                    <Trans>Only the first 50 skills are shown to the agent.</Trans>
                  </span>
                ) : null}
              </div>
              <AgentSkills />
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
      </DialogContent>
    </Dialog>
  );
}

function MarketplacesTab({
  marketplaces,
  onChanged,
  onError,
}: {
  marketplaces: SpaceMarketplace[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { t } = useLingui();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, MarketplaceUpdateCheck>>({});

  async function run(key: string, fallback: string, action: () => Promise<void>) {
    setPending(key);
    onError(null);
    try {
      await action();
    } catch (err) {
      onError(errorMessage(err, fallback));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run("add", t`Could not add marketplace`, async () => {
            await rpc.marketplaces.add({ url: url.trim(), ref: ref.trim() || undefined });
            setUrl("");
            setRef("");
            await onChanged();
          });
        }}
      >
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://github.com/owner/repo"
          aria-label={t`Marketplace URL`}
          className="min-w-0 flex-1"
        />
        <Input
          value={ref}
          onChange={(event) => setRef(event.target.value)}
          placeholder="HEAD"
          aria-label={t`Git ref`}
          className="w-32"
        />
        <Button
          type="submit"
          variant="secondary"
          className="rounded-full"
          size="sm"
          disabled={pending === "add" || !url.trim()}
        >
          {pending === "add" ? <Trans>Adding…</Trans> : <Trans>Add marketplace</Trans>}
        </Button>
      </form>

      {marketplaces.length === 0 ? (
        <p className="text-muted-foreground/80">
          <Trans>No marketplaces added yet.</Trans>
        </p>
      ) : null}

      {marketplaces.map((mkt) => {
        const check = checks[mkt.id];
        return (
          <div key={mkt.id} className="rounded-xl border border-border px-4 py-3">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-medium text-foreground">{mkt.name}</div>
                <div className="truncate text-[13px] text-muted-foreground/80">
                  {mkt.url} · {mkt.ref} @ {mkt.commit.slice(0, 7)} ·{" "}
                  <Trans>{mkt.installedPlugins.length} plugins installed</Trans>
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                className="rounded-full"
                size="sm"
                disabled={pending === `check:${mkt.id}`}
                onClick={() =>
                  void run(`check:${mkt.id}`, t`Could not check for updates`, async () => {
                    const result = await rpc.marketplaces.checkUpdate({ marketplaceId: mkt.id });
                    setChecks((prev) => ({ ...prev, [mkt.id]: result }));
                  })
                }
              >
                {pending === `check:${mkt.id}` ? (
                  <Trans>Checking…</Trans>
                ) : (
                  <Trans>Check update</Trans>
                )}
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="rounded-full"
                size="sm"
                disabled={pending === `remove:${mkt.id}`}
                onClick={() => {
                  if (!window.confirm(t`Remove marketplace ${mkt.name} and its skills?`)) return;
                  void run(`remove:${mkt.id}`, t`Could not remove marketplace`, async () => {
                    await rpc.marketplaces.remove({ marketplaceId: mkt.id });
                    await onChanged();
                  });
                }}
              >
                {pending === `remove:${mkt.id}` ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
              </Button>
            </div>

            {check ? (
              <div className="mt-3 text-[13px]">
                {check.upToDate ? (
                  <p className="text-muted-foreground">
                    <Trans>Up to date.</Trans>
                  </p>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {check.changes.map((change) => (
                        <FileChange key={change.path} change={change} />
                      ))}
                    </ul>
                    <Button
                      type="button"
                      variant="secondary"
                      className="mt-3 rounded-full"
                      size="sm"
                      disabled={pending === `apply:${mkt.id}`}
                      onClick={() =>
                        void run(`apply:${mkt.id}`, t`Could not apply update`, async () => {
                          await rpc.marketplaces.applyUpdate({
                            marketplaceId: mkt.id,
                            commit: check.commit,
                          });
                          setChecks(({ [mkt.id]: _, ...rest }) => rest);
                          await onChanged();
                        })
                      }
                    >
                      {pending === `apply:${mkt.id}` ? (
                        <Trans>Applying…</Trans>
                      ) : (
                        <Trans>Apply update to {check.commit.slice(0, 7)}</Trans>
                      )}
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const statusClass: Record<MarketplaceFileChange["status"], string> = {
  added: "text-green-600",
  removed: "text-destructive",
  modified: "text-amber-600",
};

function FileChange({ change }: { change: MarketplaceFileChange }) {
  const sizes = [change.sizeBefore, change.sizeAfter]
    .map((size) => (size === undefined ? "—" : formatBytes(size)))
    .join(" → ");
  return (
    <li>
      <span className={`font-medium ${statusClass[change.status]}`}>{change.status}</span>{" "}
      <span className="font-mono">{change.path}</span>{" "}
      <span className="text-muted-foreground">({sizes})</span>
      {/* ponytail: side-by-side before/after instead of a diff lib. */}
      {change.status === "modified" && change.before !== undefined && change.after !== undefined ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-muted-foreground">
            <Trans>Show before / after</Trans>
          </summary>
          <div className="mt-1 grid grid-cols-2 gap-2">
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2 text-xs">
              {change.before}
            </pre>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2 text-xs">
              {change.after}
            </pre>
          </div>
        </details>
      ) : null}
    </li>
  );
}

function BrowseTab({
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
  const marketplaceId = marketplaces.some((mkt) => mkt.id === selectedId)
    ? selectedId
    : (marketplaces[0]?.id ?? "");
  const marketplace = marketplaces.find((mkt) => mkt.id === marketplaceId);

  async function loadPlugins() {
    if (!marketplaceId) return setPlugins([]);
    setPlugins(await rpc.marketplaces.plugins({ marketplaceId }));
  }

  useEffect(() => {
    void loadPlugins().catch((err: unknown) =>
      onError(errorMessage(err, t`Could not load plugins`)),
    );
  }, [marketplaceId]);

  async function toggle(plugin: MarketplacePlugin) {
    if (!marketplace) return;
    setPending(plugin.name);
    onError(null);
    try {
      const input = { marketplaceId: marketplace.id, plugin: plugin.name };
      await (plugin.installed
        ? rpc.marketplaces.removePlugin(input)
        : rpc.marketplaces.installPlugin(input));
      await Promise.all([onChanged(), loadPlugins()]);
    } catch (err) {
      onError(errorMessage(err, t`Could not update plugin`));
    } finally {
      setPending(null);
    }
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

      {plugins.length === 0 ? (
        <p className="text-muted-foreground/80">
          <Trans>No plugins in this marketplace.</Trans>
        </p>
      ) : null}

      {plugins.map((plugin) => {
        const prefix = marketplace ? marketplaceSkillKey(marketplace.name, plugin.name, "") : "";
        const skills = plugin.installed ? catalog.filter((s) => s.id.startsWith(prefix)) : [];
        return (
          <div key={plugin.name} className="rounded-xl border border-border px-4 py-3">
            <div className="flex items-center gap-4">
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
                disabled={pending === plugin.name || (!plugin.supported && !plugin.installed)}
                onClick={() => void toggle(plugin)}
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
                {skills.length === 0 ? (
                  <p className="text-muted-foreground/80">
                    <Trans>No skills in this plugin.</Trans>
                  </p>
                ) : (
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
                )}
                <p className="mt-1 text-muted-foreground/80">
                  <Trans>Enable it per bot in Installed.</Trans>
                </p>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
