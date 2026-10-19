import { Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem } from "@rakazo/contracts";
import {
  buildFeaturedConnectorTiles,
  CONNECTION_CATALOG_PAGE_SIZE,
  EMPTY_PLUGIN_CATALOG_MESSAGE,
  filterConnectionCatalogItems,
} from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { AdvancedIntegrations } from "./plugins/advanced-integrations";
import { ConnectionDetail } from "./plugins/connection-detail";
import { itemKey, useIntegrations } from "./plugins/use-integrations";

export function PluginsOverlay({
  onClose,
  onOpenMcp,
  activeBotId,
  sidebar,
}: {
  onClose: () => void;
  onOpenMcp?: () => void;
  activeBotId?: string;
  sidebar?: ReactNode;
}) {
  const { t } = useLingui();
  const [setupOpen, setSetupOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(CONNECTION_CATALOG_PAGE_SIZE);
  const [installedOpen, setInstalledOpen] = useState(false);
  const integrations = useIntegrations({ activeBotId });
  const {
    catalog,
    pending,
    catalogError,
    setCatalogError,
    loading,
    detailItem,
    refresh,
    openDetail,
    itemConnected,
    installed,
    connect,
  } = integrations;

  const featuredTiles = useMemo(() => buildFeaturedConnectorTiles(catalog), [catalog]);
  const showFeatured = !query.trim();

  const visible = useMemo(() => filterConnectionCatalogItems(catalog, query), [catalog, query]);
  const rendered = visible.slice(0, visibleCount);

  function renderCatalogActions(item: ConnectionCatalogItem) {
    const key = itemKey(item);
    const connected = itemConnected(item);
    const connecting = pending === key;
    if (connected) {
      return (
        <Button
          type="button"
          variant="secondary"
          className="rounded-full"
          size="sm"
          disabled={connecting}
          onClick={(event) => {
            event.stopPropagation();
            openDetail(item);
          }}
        >
          {connecting ? <Trans>Adding…</Trans> : <Trans>Added</Trans>}
        </Button>
      );
    }
    return (
      <Button
        type="button"
        variant="secondary"
        className="rounded-full"
        size="sm"
        disabled={connecting}
        onClick={(event) => {
          event.stopPropagation();
          void connect(item);
        }}
      >
        {connecting ? <Trans>Adding…</Trans> : <Trans>Add</Trans>}
      </Button>
    );
  }

  function renderCatalogTile(
    item: ConnectionCatalogItem,
    label: string,
    logo?: string | null,
    opts?: { tileTestId?: boolean },
  ) {
    const connected = itemConnected(item);
    const tileTestId = opts?.tileTestId !== false && connected;
    const icon = logo ? (
      <img
        src={logo}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
      />
    ) : (
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
        {label[0]}
      </div>
    );
    const title = (
      <div className="min-w-0 flex-1 text-start">
        <div className="truncate text-[15px] font-medium text-foreground">{label}</div>
      </div>
    );
    return (
      <div
        key={itemKey(item)}
        data-testid={tileTestId ? `connection-tile-${item.slug.toLowerCase()}` : undefined}
        className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2"
      >
        {connected ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-start hover:bg-accent/60"
            onClick={() => openDetail(item)}
          >
            {icon}
            {title}
          </button>
        ) : (
          <>
            {icon}
            {title}
          </>
        )}
        {renderCatalogActions(item)}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        variant="window"
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[1080px] max-w-[calc(100%-2rem)] flex-row gap-0 overflow-hidden p-0 max-md:flex-col sm:max-w-[1080px]"
      >
        {sidebar}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DialogHeader className="flex-row items-start justify-between px-8 pt-7">
            <DialogTitle className="text-2xl text-foreground">
              <Trans>Integrations</Trans>
            </DialogTitle>
            <DialogClose
              render={<Button variant="ghost" size="icon-sm" aria-label={t`Close integrations`} />}
            >
              <X />
            </DialogClose>
          </DialogHeader>

          {!detailItem ? (
            <div className="px-8 pt-4">
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setVisibleCount(CONNECTION_CATALOG_PAGE_SIZE);
                }}
                aria-label={t`Search apps`}
                placeholder={t`Search apps`}
                className="h-11 rounded-xl px-4 md:text-[15px]"
              />
            </div>
          ) : null}

          <div id="integration-list" className="rk-scroll flex-1 overflow-y-auto px-8 py-6">
            <Button
              variant="outline"
              className="mb-4"
              onClick={() => setSetupOpen((current) => !current)}
            >
              <Trans>Browse MCP servers</Trans>
            </Button>
            {setupOpen ? (
              <div className="mb-6">
                <IntegrationSetup
                  botId={activeBotId}
                  onDone={() => {
                    setSetupOpen(false);
                    void refresh().catch((err: unknown) =>
                      setCatalogError(
                        err instanceof Error ? err.message : t`Could not load integrations`,
                      ),
                    );
                  }}
                />
              </div>
            ) : null}
            {catalogError ? <p className="mb-4 text-sm text-destructive">{catalogError}</p> : null}

            {detailItem ? (
              <ConnectionDetail item={detailItem} integrations={integrations} />
            ) : (
              <>
                {loading ? (
                  <p className="text-muted-foreground/80">
                    <Trans>Loading integrations…</Trans>
                  </p>
                ) : null}

                <details
                  data-testid="installed-integrations"
                  className="group mb-6"
                  onToggle={(event) =>
                    setInstalledOpen((event.currentTarget as HTMLDetailsElement).open)
                  }
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
                    <span className="text-muted-foreground">
                      <Trans>Installed integrations</Trans>
                    </span>
                    <span aria-hidden="true" className="transition-transform group-open:rotate-90">
                      ›
                    </span>
                  </summary>
                  {/* Rendered only when open so connected apps are not duplicated in the DOM. */}
                  {installedOpen ? (
                    installed.length === 0 ? (
                      <p className="mt-4 text-muted-foreground/80">
                        <Trans>No integrations installed yet.</Trans>
                      </p>
                    ) : (
                      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {installed.map((item) =>
                          // Featured already owns the connection-tile-* hit targets.
                          renderCatalogTile(item, item.name, item.logo, { tileTestId: false }),
                        )}
                      </div>
                    )
                  ) : null}
                </details>

                {showFeatured ? (
                  <div className="mb-6" data-testid="featured-connectors">
                    <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">
                      <Trans>Featured</Trans>
                    </h3>
                    {!loading && catalog.length === 0 ? (
                      <p className="text-[13.5px] leading-6 text-muted-foreground/80">
                        {EMPTY_PLUGIN_CATALOG_MESSAGE}
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {featuredTiles.map((tile) => {
                          const item = tile.item;
                          const key = item ? itemKey(item) : tile.id;
                          const disabled = tile.missing || !item;
                          if (item && !tile.missing) {
                            // Featured is the stable hit target for connection-tile-* in E2E.
                            return renderCatalogTile(item, tile.label, item.logo, {
                              tileTestId: true,
                            });
                          }
                          return (
                            <div
                              key={key}
                              className={`flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 ${
                                disabled ? "opacity-70" : ""
                              }`}
                            >
                              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
                                {tile.label[0]}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[15px] font-medium text-foreground">
                                  {tile.label}
                                </div>
                                {disabled ? (
                                  <div className="truncate text-[12.5px] text-muted-foreground">
                                    <Trans>Not in the plugin catalog</Trans>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}

                {!loading && catalog.length === 0 && !showFeatured ? (
                  <p className="text-muted-foreground/80">
                    <Trans>No managed app catalog is configured on this deployment.</Trans>
                  </p>
                ) : null}
                {!loading && catalog.length > 0 && visible.length === 0 && !showFeatured ? (
                  <p className="text-muted-foreground/80">
                    <Trans>No apps match your search.</Trans>
                  </p>
                ) : null}
                {visible.length > 0 ? (
                  <>
                    {showFeatured ? (
                      <h3 className="mb-2 text-[13px] font-medium text-muted-foreground">
                        <Trans>All integrations</Trans>
                      </h3>
                    ) : null}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {rendered.map((item) =>
                        renderCatalogTile(item, item.name, item.logo, {
                          // Avoid duplicate connection-tile-* ids while featured is also shown.
                          tileTestId: !showFeatured,
                        }),
                      )}
                    </div>
                  </>
                ) : null}
                {rendered.length < visible.length ? (
                  <div className="mt-4 flex justify-center">
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-full"
                      size="sm"
                      onClick={() =>
                        setVisibleCount((count) => count + CONNECTION_CATALOG_PAGE_SIZE)
                      }
                    >
                      <Trans>Show more</Trans>
                    </Button>
                  </div>
                ) : null}

                <AdvancedIntegrations integrations={integrations} onOpenMcp={onOpenMcp} />
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
