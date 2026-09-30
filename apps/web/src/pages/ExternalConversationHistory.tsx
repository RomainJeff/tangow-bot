import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ExternalConversation, ThreadMessage } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function ExternalConversationHistory({
  conversation,
  botName,
}: {
  conversation: ExternalConversation;
  botName: string;
}) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<number | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(false);
    void rpc.externalConversations
      .history({ externalConversationId: conversation.id }, { signal: abort.signal })
      .then((page) => {
        if (abort.signal.aborted) return;
        setMessages(page.messages);
        setAuthors(page.authors);
        setCursor(page.olderCursor);
        setSourceUrl(page.sourceUrl);
        setStatus(page.latestStatus);
        setLoading(false);
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [conversation.id, revision]);
  async function older() {
    if (cursor === null) return;
    setLoading(true);
    setError(false);
    try {
      const page = await rpc.externalConversations.history({
        externalConversationId: conversation.id,
        before: cursor,
      });
      setMessages((current) => [...page.messages, ...current]);
      setAuthors((current) => ({ ...current, ...page.authors }));
      setCursor(page.olderCursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }
  const statusLabel =
    status === "delivered"
      ? t`Reply delivered`
      : status === "running" || status === "queueing"
        ? t`In progress`
        : status === "failed"
          ? t`Delivery failed`
          : status === "ignored"
            ? t`No action needed`
            : status
              ? t`Received`
              : "";
  return (
    <div data-testid="external-conversation-history" className="mt-4 space-y-3">
      <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
        <span>{statusLabel}</span>
        {sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="underline">
            <Trans>Open in Slack</Trans>
          </a>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {error ? (
        <p className="text-destructive">
          <Trans>Could not load this chat.</Trans>
        </p>
      ) : null}
      {cursor !== null ? (
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void older()}>
          <Trans>Older messages</Trans>
        </Button>
      ) : null}
      <div className="rk-scroll max-h-[55vh] space-y-3 overflow-y-auto" aria-busy={loading}>
        {messages.map((message) => {
          // The external transcript already contains the original request. Do not
          // repeat the internal prompt assembled for the bot beside it.
          if (message.role !== "bot" && !Object.hasOwn(authors, message.id)) return null;
          const text = message.blocks
            .flatMap((block) =>
              block.kind === "text" ? [block.text] : block.kind === "ask" ? [block.text] : [],
            )
            .join("\n")
            .trim();
          if (!text) return null;
          return (
            <article key={message.id} className="rounded-lg bg-muted px-3 py-2">
              <div className="mb-1 text-[12px] text-muted-foreground">
                {message.role === "bot" ? botName : (authors[message.id] ?? t`Request`)} ·{" "}
                {new Date(message.createdAt).toLocaleString()}
              </div>
              <ChatMarkdown>{text}</ChatMarkdown>
            </article>
          );
        })}
        {!loading && !messages.length ? (
          <p>
            <Trans>No messages yet.</Trans>
          </p>
        ) : null}
      </div>
    </div>
  );
}
