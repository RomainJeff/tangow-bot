import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/web";
import type { LinkPreviewCard as LinkPreviewCardBlock, MessageBlock } from "@rakazo/contracts";
import type { LinkMentionResolver } from "@rakazo/core";
import { previewSiteLabel, sanitizePreviewTitle } from "@rakazo/core";
import { LinkPreviewCard, Surface } from "@rakazo/ui-web";
import { ArrowRight, Check } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { LinkPreviewImage } from "./message-cards";

type BlockOf<K extends MessageBlock["kind"]> = Extract<MessageBlock, { kind: K }>;

const USER_TEXT_FOLD_LINES = 20;

/** A long user message folds after 20 lines behind a fade until "Show more" is clicked. */
export function UserText({
  text,
  mentions,
}: {
  text: string;
  mentions?: LinkMentionResolver<ReactNode>;
}) {
  const [expanded, setExpanded] = useState(false);
  // ponytail: counts newlines, not wrapped lines; a 20-line max-height hides the rest either way.
  const foldable = text.split("\n").length > USER_TEXT_FOLD_LINES;
  if (!foldable) return <LinkifiedText text={text} mentions={mentions} />;
  return (
    <>
      <div
        data-testid="message-user-text"
        data-folded={!expanded}
        className={
          expanded
            ? undefined
            : "relative max-h-[calc(20*var(--type-body-leading)*var(--type-body-size))] overflow-hidden"
        }
      >
        <LinkifiedText text={text} mentions={mentions} />
        {expanded ? null : (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-chat-user to-transparent"
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="mt-1.5 text-meta font-medium text-chat-user-foreground/70 duration-(--duration-hover) ease-quiet hover:text-chat-user-foreground"
      >
        {expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
      </button>
    </>
  );
}

/** A bot this one created, opening its thread. */
export function ChildBotCard({
  block,
  onOpenBot,
}: {
  block: BlockOf<"child_bot">;
  onOpenBot: (botId: string) => void;
}) {
  const removed = block.status === "deleted" || block.status === "archived";
  return (
    <Surface className="w-[min(340px,90%)] overflow-hidden">
      <button
        type="button"
        disabled={removed}
        onClick={() => onOpenBot(block.botId)}
        className="block w-full px-4.5 py-4 text-start disabled:opacity-60"
      >
        <div className="flex items-center justify-between">
          <span className="text-author font-medium text-foreground" dir="auto">
            {block.name}
          </span>
          <span
            className={`rounded-full px-3 py-1 text-meta ${
              removed ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
            }`}
          >
            {block.status === "archived" ? (
              <Trans>archived</Trans>
            ) : block.status === "deleted" ? (
              <Trans>deleted</Trans>
            ) : (
              <Trans>bot</Trans>
            )}
          </span>
        </div>
        <div className="mt-2 text-meta text-muted-foreground" dir="auto">
          {removed
            ? block.status === "archived"
              ? t`Archived. Chat, memory, and files kept.`
              : t`Removed with chat, computer, and memory.`
            : block.title || t`Opened its thread.`}
        </div>
      </button>
    </Surface>
  );
}

/** What a run did, one checked line per result. */
export function ResultLinesCard({ block }: { block: BlockOf<"card"> }) {
  return (
    <div className="flex justify-start">
      <Surface className="flex flex-col gap-2 px-5 py-4">
        {block.lines.map((line) => (
          <div key={line.k} className="flex items-baseline gap-2.5 text-meta">
            <Check className="size-3.5 text-success" strokeWidth={2} aria-hidden />
            <span className="font-semibold text-foreground">{line.k}</span>
            <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
            <span>{line.v}</span>
          </div>
        ))}
      </Surface>
    </div>
  );
}

/** The computer's state, and what it is doing. */
export function ComputerCard({ block }: { block: BlockOf<"computer"> }) {
  return (
    <Surface className="w-[340px] px-4.5 py-4">
      <div className="flex items-center justify-between">
        <span className="text-author font-medium text-foreground">
          <Trans>Computer</Trans>
        </span>
        <span
          className={
            block.state === "Needs you"
              ? "rounded-full bg-warning/15 px-3 py-1 text-meta text-warning"
              : "rounded-full bg-success/15 px-3 py-1 text-meta text-success"
          }
        >
          {block.state}
        </span>
      </div>
      <div className="my-2.5 text-meta text-muted-foreground">
        <ChatMarkdown>{block.text}</ChatMarkdown>
      </div>
    </Surface>
  );
}

/** A preview card under the bubble it stands for, aligned to its edge and capped to its width. */
export function LinkPreviewRow({
  card,
  artifactTarget,
  side,
  inGroup,
}: {
  card: LinkPreviewCardBlock;
  artifactTarget: ArtifactTarget;
  side: "user" | "bot";
  inGroup: boolean;
}) {
  const image = card.image;
  return (
    <div className={`mt-1 flex first:mt-0 ${side === "user" ? "justify-end" : "justify-start"}`}>
      <LinkPreviewCard
        // The same width cap as the bubble it stands for, so the side still says who sent it.
        className={side === "user" ? "max-w-39/50" : inGroup ? "max-w-22/25" : "max-w-41/50"}
        href={card.url}
        site={previewSiteLabel(card.url)}
        title={card.title ? sanitizePreviewTitle(card.title) : undefined}
        format={card.format}
        imageRatio={image ? image.width / image.height : undefined}
        image={
          image ? (
            <LinkPreviewImage
              target={artifactTarget}
              artifactId={image.artifactId}
              fit={image.fit}
            />
          ) : undefined
        }
      />
    </div>
  );
}
