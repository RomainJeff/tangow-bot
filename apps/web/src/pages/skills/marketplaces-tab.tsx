import { Trans, useLingui } from "@lingui/react/macro";
import type {
  MarketplaceFileChange,
  MarketplaceUpdateCheck,
  SpaceMarketplace,
} from "@rakazo/contracts";
import { Badge, Button, Input } from "@rakazo/ui-web";
import { useState } from "react";
import { formatBytes } from "../../components/ArtifactFileCard";
import { rpc } from "../../lib/rpc";
import { errorMessage } from "./error-message";

export function MarketplacesTab({
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

      <p className="-mt-3 text-[13px] text-muted-foreground/80">
        <Trans>
          A plugin marketplace (.claude-plugin/marketplace.json) or a repository of skills (SKILL.md
          files). The format is detected automatically.
        </Trans>
      </p>

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
                <div className="flex items-center gap-2 text-[15px] font-medium text-foreground">
                  {mkt.name}
                  <Badge variant="outline" className="shrink-0">
                    {mkt.kind === "skills" ? <Trans>Skills</Trans> : <Trans>Plugins</Trans>}
                  </Badge>
                </div>
                <div className="truncate text-[13px] text-muted-foreground/80">
                  {mkt.url} · {mkt.ref} @ {mkt.commit.slice(0, 7)} ·{" "}
                  {mkt.kind === "skills" ? (
                    <Trans>{mkt.installedPlugins.length} skills installed</Trans>
                  ) : (
                    <Trans>{mkt.installedPlugins.length} plugins installed</Trans>
                  )}
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
