import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import type { Integrations } from "./use-integrations";

export function AdvancedIntegrations({
  integrations,
  onOpenMcp,
}: {
  integrations: Integrations;
  onOpenMcp?: () => void;
}) {
  const { t } = useLingui();
  const {
    sources,
    sourceKind,
    setSourceKind,
    sourceName,
    setSourceName,
    sourceUrl,
    setSourceUrl,
    credential,
    setCredential,
    authType,
    setAuthType,
    authName,
    setAuthName,
    pending,
    sourceError,
    setSourceError,
    sourceHint,
    setSourceHint,
    catalogFeedEnabled,
    catalogFeedQuery,
    setCatalogFeedQuery,
    catalogFeedResults,
    setCatalogFeedResults,
    catalogFeedError,
    setCatalogFeedError,
    catalogFeedPending,
    catalogFeedSearched,
    setCatalogFeedSearched,
    beginSource,
    searchCatalogFeed,
    beginCatalogSurface,
    installSource,
    removeSource,
  } = integrations;

  return (
    <details
      data-testid="integrations-advanced"
      className="group mt-8"
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open) {
          setSourceKind(null);
          setSourceError(null);
          setSourceHint(null);
          setSourceName("");
          setSourceUrl("");
          setCredential("");
          setAuthType("none");
          setAuthName("x-api-key");
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
        <span className="text-muted-foreground">
          <Trans>Advanced</Trans>
        </span>
        <span aria-hidden="true" className="transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>

      <div className="mt-4 space-y-4">
        {catalogFeedEnabled ? (
          <Card data-testid="integrations-catalog-feed">
            <CardHeader>
              <CardTitle>
                <Trans>Search by domain</Trans>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void searchCatalogFeed();
                }}
              >
                <Input
                  value={catalogFeedQuery}
                  disabled={catalogFeedPending}
                  onChange={(event) => {
                    setCatalogFeedQuery(event.target.value);
                    setCatalogFeedResults([]);
                    setCatalogFeedError(null);
                    setCatalogFeedSearched(false);
                  }}
                  placeholder="github.com"
                  aria-label={t`Integration domain`}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  disabled={!catalogFeedQuery.trim() || catalogFeedPending}
                >
                  {catalogFeedPending ? <Trans>Searching…</Trans> : <Trans>Search</Trans>}
                </Button>
              </form>
              {catalogFeedError ? (
                <p className="text-sm text-destructive">{catalogFeedError}</p>
              ) : null}
              {catalogFeedSearched && !catalogFeedPending && catalogFeedResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>No results</Trans>
                </p>
              ) : null}
              {catalogFeedResults.map((result) => (
                <div
                  key={`${result.domain}:${result.name}:${result.pageUrl ?? ""}`}
                  className="rounded-xl border border-border/70 p-3"
                >
                  <div className="font-medium text-foreground">
                    {result.pageUrl ? (
                      <a
                        href={result.pageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {result.name}
                      </a>
                    ) : (
                      result.name
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{result.domain}</div>
                  {result.description ? (
                    <p className="mt-2 text-sm leading-5 text-muted-foreground">
                      {result.description}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {result.surfaces.map((surface) => {
                      const canAdd =
                        Boolean(surface.source) &&
                        (surface.kind === "mcp" || surface.kind === "openapi");
                      return (
                        <Button
                          key={`${result.domain}:${surface.slug}`}
                          type="button"
                          variant="secondary"
                          className="rounded-full"
                          size="sm"
                          disabled={!canAdd}
                          title={canAdd ? undefined : t`Manual setup required`}
                          onClick={() => beginCatalogSurface(result, surface)}
                        >
                          {surface.kind.toUpperCase()} · {canAdd ? t`Add` : t`Manual`}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <div data-testid="integrations-advanced-add" className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            onClick={() => beginSource("mcp")}
          >
            <Trans>Add MCP server</Trans>
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            onClick={() => beginSource("api")}
          >
            <Trans>Add OpenAPI</Trans>
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            onClick={() => beginSource("graphql")}
          >
            <Trans>Add GraphQL</Trans>
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            onClick={() => beginSource("executor")}
          >
            <Trans>Add Executor</Trans>
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            size="sm"
            onClick={() => beginSource("treg")}
          >
            <Trans>Add Treg</Trans>
          </Button>
        </div>

        {sourceError ? <p className="text-sm text-destructive">{sourceError}</p> : null}

        {sourceKind ? (
          <Card>
            <CardHeader>
              <CardTitle>
                {sourceKind === "treg" ? (
                  <Trans>Connect Treg</Trans>
                ) : sourceKind === "executor" ? (
                  <Trans>Connect Executor</Trans>
                ) : sourceKind === "mcp" ? (
                  <Trans>Add remote MCP server</Trans>
                ) : sourceKind === "graphql" ? (
                  <Trans>Add GraphQL endpoint</Trans>
                ) : (
                  <Trans>Import OpenAPI JSON</Trans>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                value={sourceName}
                onChange={(event) => setSourceName(event.target.value)}
                placeholder={t`Display name`}
              />
              {sourceKind !== "treg" ? (
                <Input
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder={
                    sourceKind === "mcp"
                      ? "https://example.com/mcp"
                      : sourceKind === "executor"
                        ? "https://executor.example/mcp"
                        : sourceKind === "graphql"
                          ? "https://example.com/graphql"
                          : "https://example.com/openapi.json"
                  }
                />
              ) : null}
              {sourceKind !== "treg" && sourceKind !== "executor" ? (
                <NativeSelect
                  className="w-full"
                  value={authType}
                  onChange={(event) => setAuthType(event.target.value as typeof authType)}
                >
                  <NativeSelectOption value="none">
                    <Trans>No authentication</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="bearer">
                    <Trans>Bearer token</Trans>
                  </NativeSelectOption>
                  <NativeSelectOption value="header">
                    <Trans>API key header</Trans>
                  </NativeSelectOption>
                </NativeSelect>
              ) : null}
              {authType === "header" && sourceKind !== "treg" && sourceKind !== "executor" ? (
                <Input
                  value={authName}
                  onChange={(event) => setAuthName(event.target.value)}
                  placeholder={t`Header name`}
                />
              ) : null}
              {sourceKind === "treg" || sourceKind === "executor" || authType !== "none" ? (
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={
                    sourceKind === "treg"
                      ? t`Treg token`
                      : sourceKind === "executor"
                        ? t`Executor token`
                        : t`Credential`
                  }
                />
              ) : null}
              <p className="text-xs leading-5 text-muted-foreground">
                <Trans>Credentials are encrypted and never sent to the model.</Trans>
              </p>
              {sourceHint ? (
                <p className="text-xs leading-5 text-muted-foreground">{sourceHint}</p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  disabled={pending === "install-source"}
                  onClick={() => void installSource()}
                >
                  {pending === "install-source" ? (
                    <Trans>Verifying…</Trans>
                  ) : (
                    <Trans>Verify and add</Trans>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="rounded-full"
                  size="sm"
                  onClick={() => setSourceKind(null)}
                >
                  <Trans>Cancel</Trans>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div>
          <div className="mb-3 text-sm font-medium text-foreground/75">
            <Trans>Tool sources</Trans>
          </div>
          {sources.length === 0 && !sourceKind ? (
            <p className="text-muted-foreground/80">
              <Trans>No MCP or API tool sources installed yet.</Trans>
            </p>
          ) : null}
          {sources.map((source) => (
            <div key={source.id} className="flex items-center gap-4 rounded-xl px-3 py-2.5">
              <div className="grid h-[42px] w-[42px] place-items-center rounded-xl bg-accent font-semibold uppercase text-foreground">
                {source.kind === "mcp" ? "M" : source.kind === "graphql" ? "G" : "A"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15.5px] font-medium text-foreground">{source.name}</div>
                <div className="truncate text-[13.5px] text-muted-foreground/70">
                  {source.kind.toUpperCase()} · {source.source} ·{" "}
                  {source.secretConfigured ? (
                    <Trans>credential saved</Trans>
                  ) : (
                    <Trans>no auth</Trans>
                  )}
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                className="rounded-full"
                size="sm"
                disabled={pending === source.id}
                onClick={() => void removeSource(source)}
              >
                {pending === source.id ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
              </Button>
            </div>
          ))}
          {onOpenMcp ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="mt-2 px-0 text-muted-foreground"
              onClick={onOpenMcp}
            >
              <Trans>Manage MCP servers</Trans>
            </Button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
