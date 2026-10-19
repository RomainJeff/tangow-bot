import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type {
  MemoryCollectionKind,
  MemoryLibraryDocument,
  MemoryLibraryRevision,
  MemoryLibrarySummary,
  MemoryMethodAnnotation,
  SpaceNavigation,
} from "@rakazo/contracts";
import { MemoryCollectionKindSchema } from "@rakazo/contracts";
import { latestAnnotationPerBot, memoryLocation } from "@rakazo/core";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { rpc, selectedSpaceId, selectSpace } from "../lib/rpc";

const statuses = ["active", "proposed", "withdrawn"] as const;
function useCollectionLabel() {
  const { t } = useLingui();
  return (kind: MemoryCollectionKind) =>
    kind === "personal" ? t`Personal` : kind === "agent" ? t`Bot` : t`Space`;
}

/** Reading surface. Memory changes are handled by the selected bot in conversation. */
export function MemoryLibraryPage() {
  const { t } = useLingui();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSpaceId = params.get("space") ?? selectedSpaceId();
  const [navigation, setNavigation] = useState<SpaceNavigation | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setNavigation(null);
    setError(false);
    void rpc.spaces.list(undefined, { context: { spaceId: requestedSpaceId } }).then(
      (result) => {
        if (active) setNavigation(result);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [requestedSpaceId]);
  useEffect(() => {
    if (!navigation || params.has("space")) return;
    const next = new URLSearchParams(params);
    next.set("space", navigation.current.id);
    setParams(next, { replace: true, state: location.state });
  }, [navigation, params, setParams, location.state]);
  if (!navigation || (requestedSpaceId && navigation.current.id !== requestedSpaceId)) {
    return (
      <main className="p-5" aria-busy={!error}>
        <Button
          variant="tertiary"
          size="icon"
          aria-label={t`Back`}
          onClick={() => navigate(location.state?.returnTo ?? "/app", { replace: true })}
        >
          <ArrowLeft className="size-5" />
        </Button>
        {error ? (
          <p role="alert" className="text-meta text-destructive">{t`Could not load space`}</p>
        ) : null}
      </main>
    );
  }
  return <MemoryLibrary key={navigation.current.id} workspace={navigation} />;
}

function MemoryLibrary({ workspace }: { workspace: SpaceNavigation }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation: { returnTo?: string; fromMemoryList?: boolean } | null = location.state;
  const [params, setParams] = useSearchParams();
  const pendingParams = useRef(params);
  useLayoutEffect(() => {
    pendingParams.current = params;
  }, [params]);
  const collection = MemoryCollectionKindSchema.catch("space").parse(params.get("collection"));
  const botId = params.get("bot") ?? undefined;
  const query = params.get("q") ?? "";
  const selectedId = params.get("memory");
  const status = statuses.includes(params.get("status") as (typeof statuses)[number])
    ? (params.get("status") as (typeof statuses)[number])
    : "active";
  const [items, setItems] = useState<MemoryLibrarySummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryLibraryDocument | null>(null);
  const bots = workspace.current.bots.filter((bot) => !bot.archivedAt);
  const spaceId = workspace.current.id;
  const collectionLabel = useCollectionLabel();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const filters = useMemo(
    () => ({
      collection,
      ...(collection === "agent" && botId ? { botId } : {}),
      query: query || undefined,
      status,
      limit: 30,
    }),
    [collection, botId, query, status],
  );
  function change(
    next: Record<string, string | null>,
    { openDetail = false }: { openDetail?: boolean } = {},
  ) {
    const copy = new URLSearchParams(pendingParams.current);
    copy.set("space", spaceId);
    for (const [key, value] of Object.entries(next))
      value ? copy.set(key, value) : copy.delete(key);
    if (copy.toString() === pendingParams.current.toString()) return;
    // Consecutive input events must compose even before the router commits its next render.
    pendingParams.current = copy;
    // Filters and dismissals update the current screen; only opening a detail adds a step.
    setParams(copy, {
      replace: !openDetail,
      state: { ...navigation, fromMemoryList: openDetail },
    });
  }
  function closeMemory() {
    if (navigation?.fromMemoryList) navigate(-1);
    else change({ memory: null });
  }
  function leaveLibrary() {
    navigate(navigation?.returnTo ?? (botId ? `/app/${encodeURIComponent(botId)}` : "/app"), {
      replace: true,
    });
  }
  useEffect(() => {
    const current = ++request.current;
    setItems([]);
    setNextCursor(null);
    setLoading(true);
    setError(null);
    void rpc.memory.library.list(filters, { context: { spaceId } }).then(
      (result) => {
        if (current !== request.current) return;
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setLoading(false);
      },
      () => {
        if (current === request.current) {
          setError(t`Could not load memories`);
          setLoading(false);
        }
      },
    );
    return () => {
      request.current += 1;
    };
  }, [filters, t, spaceId]);
  useEffect(() => {
    let active = true;
    setSelected(null);
    if (selectedId)
      void rpc.memory.library.get({ documentId: selectedId }, { context: { spaceId } }).then(
        (document) => {
          if (active) setSelected(document);
        },
        () => {
          if (active) setError(t`Could not load memory`);
        },
      );
    return () => {
      active = false;
    };
  }, [selectedId, t, spaceId]);
  async function loadMore() {
    if (!nextCursor || loading) return;
    const current = request.current;
    setLoading(true);
    try {
      const result = await rpc.memory.library.list(
        { ...filters, cursor: nextCursor },
        { context: { spaceId } },
      );
      if (current === request.current) {
        setItems((items) => [...items, ...result.items]);
        setNextCursor(result.nextCursor);
      }
    } catch {
      if (current === request.current) setError(t`Could not load memories`);
    } finally {
      if (current === request.current) setLoading(false);
    }
  }
  return (
    <main className="rk-scroll h-full overflow-y-auto p-5" data-testid="memory-library">
      <header className="mb-5 flex items-center gap-3">
        <Button variant="tertiary" size="icon" aria-label={t`Back`} onClick={leaveLibrary}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="text-section-title">
          <Trans>Memory</Trans>
        </h1>
      </header>
      <NativeSelect
        aria-label={t`Space`}
        value={spaceId}
        className="mb-4 w-full sm:w-fit"
        onChange={(event) => change({ space: event.target.value, bot: null, memory: null })}
      >
        {workspace.spaces.map((space) => (
          <NativeSelectOption key={space.id} value={space.id}>
            {space.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <fieldset className="mb-3 flex flex-wrap gap-2">
        <legend className="sr-only">
          <Trans>Memory scope</Trans>
        </legend>
        {(["space", "personal", "agent"] as const).map((kind) => (
          <Button
            key={kind}
            variant="tertiary"
            size="capsule"
            aria-pressed={collection === kind}
            onClick={() => change({ collection: kind, memory: null })}
          >
            {collectionLabel(kind)}
          </Button>
        ))}
      </fieldset>
      {collection === "agent" ? (
        <NativeSelect
          aria-label={t`Bot`}
          value={botId ?? ""}
          onChange={(event) => change({ bot: event.target.value || null, memory: null })}
          className="mb-3"
        >
          <NativeSelectOption value="">{t`All bots`}</NativeSelectOption>
          {bots.map((bot) => (
            <NativeSelectOption key={bot.id} value={bot.id}>
              {bot.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
      <div className="relative mb-3">
        <Search
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(event) => change({ q: event.target.value, memory: null })}
          placeholder={t`Search`}
          aria-label={t`Search memories`}
          className="ps-9"
        />
      </div>
      <div className="mb-3 flex gap-1" role="tablist" aria-label={t`Memory status`}>
        {statuses.map((value) => (
          <Button
            key={value}
            variant="tertiary"
            size="quickReply"
            aria-pressed={status === value}
            onClick={() => change({ status: value, memory: null })}
          >
            {value === "active" ? t`Active` : value === "proposed" ? t`Proposals` : t`Withdrawn`}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      ) : null}
      <section className="divide-y divide-border" data-testid="memory-list" aria-busy={loading}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => change({ memory: item.id }, { openDetail: true })}
            className="flex w-full items-center justify-between gap-3 py-3 text-start hover:bg-accent"
          >
            <span className="min-w-0">
              <span className="block truncate text-row-name" dir="auto">
                {item.title || t`Untitled memory`}
              </span>
              {collection === "agent" && !botId ? (
                <span className="block truncate text-meta text-muted-foreground" dir="auto">
                  {bots.find((bot) => bot.id === item.collection.botId)?.name ?? t`Bot`}
                </span>
              ) : null}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
        {!loading && !items.length ? (
          <p className="py-6 text-meta text-muted-foreground">
            <Trans>Nothing remembered yet</Trans>
          </p>
        ) : null}
      </section>
      {nextCursor ? (
        <Button
          className="mt-3"
          variant="tertiary"
          size="quickReply"
          disabled={loading}
          onClick={() => void loadMore()}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
      {selected ? (
        <MemoryDetail
          key={selected.id}
          document={selected}
          workspace={workspace}
          onClose={closeMemory}
        />
      ) : null}
    </main>
  );
}

function MemoryDetail({
  document,
  workspace,
  onClose,
}: {
  document: MemoryLibraryDocument;
  workspace: SpaceNavigation;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const spaceId = workspace.current.id;
  const collectionLabel = useCollectionLabel();
  const [history, setHistory] = useState<MemoryLibraryRevision[] | null>(null);
  const [annotations, setAnnotations] = useState<MemoryMethodAnnotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void rpc.memory.library
      .annotations({ documentId: document.id }, { context: { spaceId } })
      .then((items) => {
        if (active) setAnnotations(items);
      })
      .catch(() => {
        if (active) setError(t`Could not load memory`);
      });
    return () => {
      active = false;
    };
  }, [document.id, t, spaceId]);
  const current = latestAnnotationPerBot(annotations);
  return (
    <section
      className="fixed inset-0 z-40 flex justify-end bg-background/80"
      data-testid="memory-detail"
    >
      <div className="rk-scroll h-full w-full max-w-2xl overflow-y-auto border-s border-border bg-background p-5">
        <Button variant="tertiary" size="icon" aria-label={t`Close memory`} onClick={onClose}>
          <ArrowLeft className="size-5" />
        </Button>
        <h2 className="my-5 text-section-title" dir="auto">
          {document.title || t`Untitled memory`}
        </h2>
        <p className="mb-4 text-meta text-muted-foreground" data-testid="memory-location">
          {memoryLocation(
            workspace.current.name,
            collectionLabel(document.collection.kind),
            document.collection.botId
              ? (workspace.current.bots.find((bot) => bot.id === document.collection.botId)?.name ??
                  t`Bot`)
              : undefined,
          )}
        </p>
        <div className="memory-markdown">
          <ChatMarkdown allowImages={false}>{document.content}</ChatMarkdown>
        </div>
        {current.map((item) => (
          <div key={item.id} className="mt-5 space-y-2 border-t border-border pt-3">
            <Button
              variant="tertiary"
              size="quickReply"
              onClick={() => {
                if (selectSpace(spaceId)) navigate(`/app/${item.bot.id}`);
                else setError(t`Could not load space`);
              }}
            >
              {item.bot.name}
            </Button>
            <dl>
              {item.method.questions.map((question) => (
                <div key={question.key} className="flex gap-2 text-meta">
                  <dt className="text-muted-foreground">{question.label}</dt>
                  <dd>
                    {question.options.find((option) => option.key === item.answers[question.key])
                      ?.label ?? t`None`}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        <details className="mt-5 text-meta">
          <summary className="cursor-pointer text-muted-foreground">
            <Trans>Details</Trans>
          </summary>
          <div className="space-y-3 pt-3">
            {document.qualification.documentType ? (
              <p>{document.qualification.documentType}</p>
            ) : null}
            {document.qualification.subjects.length ? (
              <p>{document.qualification.subjects.join(", ")}</p>
            ) : null}
            {document.validFrom ? (
              <p>
                <Trans>Valid from</Trans> {document.validFrom}
              </p>
            ) : null}
            {document.validUntil ? (
              <p>
                <Trans>Valid until</Trans> {document.validUntil}
              </p>
            ) : null}
            {(document.evidence?.length ? document.evidence : document.sources).map(
              (source, index) =>
                source.excerpt ? (
                  <blockquote className="border-s border-border ps-3" key={index} dir="auto">
                    {source.excerpt}
                  </blockquote>
                ) : null,
            )}
            <Button
              variant="tertiary"
              size="quickReply"
              onClick={() =>
                void rpc.memory.library
                  .history({ documentId: document.id }, { context: { spaceId } })
                  .then(setHistory)
                  .catch(() => setError(t`Could not load history`))
              }
            >
              <Trans>History</Trans>
            </Button>
            {history?.map((revision) => (
              <details key={revision.id}>
                <summary>rev {revision.revision}</summary>
                <ChatMarkdown allowImages={false}>{revision.content}</ChatMarkdown>
              </details>
            ))}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </details>
      </div>
    </section>
  );
}
