import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/web";
import type { LinkPreviewCard as LinkPreviewCardBlock, MessageBlock } from "@rakazo/contracts";
import type { LinkMentionResolver } from "@rakazo/core";
import { previewSiteLabel, sanitizePreviewTitle } from "@rakazo/core";
import { Button, cn, LinkPreviewCard, Surface } from "@rakazo/ui-web";
import { ArrowRight, Check, Monitor } from "lucide-react";
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
  avatar,
  onOpenBot,
}: {
  block: BlockOf<"child_bot">;
  avatar: ReactNode;
  onOpenBot: (botId: string) => void;
}) {
  const removed = block.status === "deleted" || block.status === "archived";
  return (
    <Surface className="w-link-card max-w-full overflow-hidden">
      <button
        type="button"
        disabled={removed}
        onClick={() => onOpenBot(block.botId)}
        className="flex w-full items-center gap-3 px-4 py-3 text-start duration-(--duration-hover) ease-quiet enabled:hover:bg-pressed/40 disabled:opacity-60"
      >
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-row-name font-semibold text-foreground" dir="auto">
            {block.name}
          </span>
          <span className="block text-meta text-muted-foreground" dir="auto">
            {removed
              ? block.status === "archived"
                ? t`Archived. Chat, memory, and files kept.`
                : t`Removed with chat, computer, and memory.`
              : block.title || t`Opened its thread.`}
          </span>
        </span>
      </button>
    </Surface>
  );
}

/** What a run did, one checked line per result. */
export function ResultLinesCard({ block }: { block: BlockOf<"card"> }) {
  return (
    <div className="flex justify-start">
      <Surface className="flex flex-col gap-2 p-4">
        {block.lines.map((line) => (
          <div key={line.k} className="flex items-center gap-3 text-row-name">
            <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="font-medium text-foreground">{line.k}</span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span>{line.v}</span>
          </div>
        ))}
      </Surface>
    </div>
  );
}

/**
 * The computer's state, and what it is doing. `onOpen` is set only on your live Needs you card;
 * `waitingOn` names the person another person's live card waits on.
 */
export function ComputerCard({
  block,
  onOpen,
  waitingOn,
}: {
  block: BlockOf<"computer">;
  onOpen?: () => void;
  waitingOn?: string;
}) {
  const needsYou = block.state === "Needs you" && waitingOn === undefined;
  return (
    <Surface className="flex w-link-card max-w-full items-center gap-3 px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-row bg-well text-foreground">
        <Monitor className="size-4.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-row-name font-semibold text-foreground">
          <Trans>Computer</Trans>
        </div>
        <div className="text-meta text-muted-foreground">
          <ChatMarkdown>{block.text}</ChatMarkdown>
        </div>
      </div>
      {onOpen && needsYou ? (
        <Button
          type="button"
          variant="capsule"
          size="capsule"
          className="shrink-0"
          data-testid="takeover-open-computer"
          onClick={onOpen}
        >
          <Trans>Open</Trans>
        </Button>
      ) : (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-block-header",
            needsYou ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {needsYou ? <span aria-hidden className="size-1.5 rounded-full bg-foreground" /> : null}
          {waitingOn !== undefined ? t`Waiting for ${waitingOn}` : block.state}
        </span>
      )}
    </Surface>
  );
}

/** The width cap of the bubble a card or a stack of images stands for, so the side still says who sent it. */
export function sideWidthCap(side: "user" | "bot", inGroup: boolean): string {
  return side === "user" ? "max-w-39/50" : inGroup ? "max-w-22/25" : "max-w-41/50";
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
    <div className={`flex w-full ${side === "user" ? "justify-end" : "justify-start"}`}>
      <LinkPreviewCard
        className={sideWidthCap(side, inGroup)}
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
