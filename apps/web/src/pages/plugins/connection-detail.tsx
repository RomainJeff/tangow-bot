import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ConnectionCatalogItem } from "@rakazo/contracts";
import { humanizeToolName } from "@rakazo/core";
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from "@rakazo/ui-web";
import { ChevronDown, ChevronLeft, ChevronUp } from "lucide-react";
import { activeAccounts, type Integrations, itemKey } from "./use-integrations";

export function ConnectionDetail({
  item,
  integrations,
}: {
  item: ConnectionCatalogItem;
  integrations: Integrations;
}) {
  const { t } = useLingui();
  const {
    connections,
    labelDrafts,
    setLabelDrafts,
    pending,
    tools,
    toolsLoading,
    toolsOpen,
    setToolsOpen,
    closeDetail,
    connect,
    revokeAccount,
    uninstall,
    renameAccount,
  } = integrations;
  const accounts = activeAccounts(connections, item);
  const key = itemKey(item);
  const connecting = pending === key;
  const uninstalling = pending === `uninstall:${key}`;
  const toolCount = tools.length;

  return (
    <div data-testid="connection-detail" className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t`Back`}
            onClick={closeDetail}
          >
            <ChevronLeft />
          </Button>
          {item.logo ? (
            <img
              src={item.logo}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-9 w-9 shrink-0 rounded-xl bg-accent object-contain"
            />
          ) : (
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent text-sm font-semibold text-foreground">
              {item.name[0]}
            </div>
          )}
          <div className="truncate text-[17px] font-medium text-foreground">{item.name}</div>
        </div>
        <Button
          type="button"
          variant="secondary"
          className="rounded-full"
          size="sm"
          disabled={uninstalling || connecting}
          onClick={() => void uninstall(item)}
        >
          {uninstalling ? <Trans>Removing…</Trans> : <Trans>Uninstall</Trans>}
        </Button>
      </div>

      <Card data-testid="connection-accounts">
        <CardHeader>
          <CardTitle>
            <Trans>Accounts</Trans>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {accounts.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <Input
                value={labelDrafts[row.id] ?? row.displayName}
                aria-label={t`Account label`}
                className="h-9 rounded-lg px-3 text-[13px]"
                onChange={(event) =>
                  setLabelDrafts((current) => ({ ...current, [row.id]: event.target.value }))
                }
                onBlur={() => void renameAccount(row)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              <Button
                type="button"
                variant="ghost"
                className="h-9 shrink-0 rounded-full px-2 text-[12px]"
                size="sm"
                disabled={pending === row.id || uninstalling}
                onClick={() => void revokeAccount(row, item)}
              >
                {pending === row.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            disabled={connecting || uninstalling}
            onClick={() => void connect(item)}
          >
            {connecting ? <Trans>Adding…</Trans> : <Trans>Add another</Trans>}
          </Button>
        </CardContent>
      </Card>

      <Card data-testid="connection-tools">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left"
          onClick={() => setToolsOpen((open) => !open)}
          aria-expanded={toolsOpen}
        >
          <span className="text-base font-medium text-foreground">
            {toolsLoading ? (
              <Trans>Tools</Trans>
            ) : (
              <Plural value={toolCount} one="# tool" other="# tools" />
            )}
          </span>
          {toolsOpen ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>
        {toolsOpen ? (
          <CardContent className="border-t border-border pt-3">
            {toolsLoading ? (
              <p className="text-sm text-muted-foreground">
                <Trans>Loading tools…</Trans>
              </p>
            ) : tools.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No tools available.</Trans>
              </p>
            ) : (
              <ul className="space-y-2">
                {tools.map((tool) => (
                  <li key={tool.name} className="text-sm text-foreground">
                    {humanizeToolName(tool.name)}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
