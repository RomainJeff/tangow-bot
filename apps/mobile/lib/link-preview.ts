import type { LinkPreviewBlock, LinkPreviewCard, MessageBlock } from "@tangow/contracts";
import { isLinkPreviewCard, isPreviewableUrl } from "@tangow/contracts";
import {
  isLinkOnlyMessage,
  messageHostsLinkPreview,
  previewSiteLabel,
  sanitizePreviewTitle,
  textWithoutPreviewedLinkLine,
} from "@tangow/core";
import { linkLargeImageRatio, sizes } from "@tangow/ui-tokens";

/**
 * The card a message shows, or undefined when it shows none. Blocks reach the phone from live
 * events without a schema pass, so the shape is checked again here: a removal marker anywhere in
 * the message wins (a removed preview never comes back), the url must be http(s), and the format
 * must carry what it draws. A card that fails any of it is dropped, never partly drawn. A
 * message that is itself a card (`messageHostsLinkPreview`) shows none, and the title is cleaned
 * again here, as on web: the screen never trusts what the server stored.
 */
export function linkPreviewCardOf(message: {
  role: string;
  blocks: readonly MessageBlock[];
}): LinkPreviewCard | undefined {
  if (!messageHostsLinkPreview(message)) return undefined;
  const previews = message.blocks.filter(
    (block): block is LinkPreviewBlock => block.kind === "link_preview",
  );
  if (previews.length === 0 || previews.some((block) => block.removed)) return undefined;
  const card = previews.find(isLinkPreviewCard);
  if (!card || !isPreviewableUrl(card.url)) return undefined;
  if (card.format !== "compact" && !card.image) return undefined;
  const title = card.title ? sanitizePreviewTitle(card.title) || undefined : undefined;
  if (card.format !== "photo" && !title) return undefined;
  return title === card.title ? card : { ...card, title };
}

/** The only url a card may open: http(s), no credentials. Never `tel:`, `mailto:` or a custom scheme. */
export function openableLinkPreviewUrl(url: string): string | undefined {
  return isPreviewableUrl(url) ? url : undefined;
}

/**
 * Block kinds that can sit next to a bare link without giving the message a bubble of its own.
 * Reasoning is never drawn; steps are, when shown, so they keep the bubble. Skill lines hang under
 * the card instead, and a link mention only marks up a link inside the text.
 */
const CARD_COMPANION_KINDS = new Set<string>([
  "text",
  "link_preview",
  "link_mention",
  "reasoning",
  "skill_source",
]);

/**
 * True when the card takes the bubble's place: the message is nothing but this link (bare, in
 * `<>`, or a link labelled with itself) and carries no other visible content. Pass the blocks the
 * row draws (`visibleMessageBlocks`), so steps count only when they are shown.
 */
export function cardReplacesBubble(
  blocks: readonly MessageBlock[],
  card: LinkPreviewCard,
): boolean {
  if (!blocks.every((block) => CARD_COMPANION_KINDS.has(block.kind))) return false;
  const text = blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n");
  return isLinkOnlyMessage(text, card.url);
}

/**
 * The blocks a bubble draws when its card shows the link: each text without the lines that are
 * only that link (`textWithoutPreviewedLinkLine`), a text that was nothing else dropped. Display
 * only: the stored message, its copy and what the model reads keep the link. Blocks that are not
 * text, and texts with no such line, come back as they are.
 */
export function blocksWithoutPreviewedLinkLine(
  blocks: readonly MessageBlock[],
  url: string,
): readonly MessageBlock[] {
  return blocks.flatMap((block): MessageBlock[] => {
    if (block.kind !== "text") return [block];
    const text = textWithoutPreviewedLinkLine(block.text, url);
    if (text === block.text) return [block];
    return text ? [{ ...block, text }] : [];
  });
}

/** The accessible name of the card: "title, site", or the site alone for a photo. */
export function linkPreviewLabel(card: LinkPreviewCard): string {
  return [card.title, previewSiteLabel(card.url)].filter(Boolean).join(", ");
}

/**
 * The card's width as a number, never a percentage: it caps at the bubble's own column (82% of a
 * single-bot thread, 88% of the column right of a group's avatar) and at the `linkCard` token. A
 * percentage on content that fits its content has nothing definite to resolve against.
 */
export function linkCardWidth({
  windowWidth,
  gutter,
  avatarColumn,
  mono,
  byPerson = false,
}: {
  windowWidth: number;
  gutter: number;
  /** Width of the avatar column plus its gap, 0 when there is none. */
  avatarColumn: number;
  mono: boolean;
  /** The person's own card: capped like the user bubble (78%), so its side still says who sent it. */
  byPerson?: boolean;
}): number {
  const column = windowWidth - gutter * 2 - (mono ? 0 : avatarColumn);
  const share = byPerson ? 0.78 : mono ? 0.82 : 0.88;
  return Math.max(0, Math.min(sizes.linkCard, Math.floor(column * share)));
}

/**
 * The image's height at the card's width: the fixed large ratio, or a photo at its own
 * proportions capped at `linkPhotoMax`. The page's declared size is never trusted for layout
 * beyond the proportions the server measured on the bytes it kept.
 */
export function linkPreviewImageHeight(card: LinkPreviewCard, width: number): number | undefined {
  if (card.format === "large") return Math.round(width / linkLargeImageRatio);
  if (card.format === "photo" && card.image) {
    return Math.min(sizes.linkPhotoMax, Math.round((width * card.image.height) / card.image.width));
  }
  return undefined;
}

/**
 * How an image sits in its frame: cropped at the center by default, or, for a site icon (a compact
 * card's image marked `contain`), shown whole and centered with a small inset. Anything else
 * marked `contain` is cropped: an icon never belongs to another format.
 */
export function linkPreviewImageFit(card: Pick<LinkPreviewCard, "format" | "image">): {
  resizeMode: "cover" | "contain";
  inset: number;
} {
  return card.format === "compact" && card.image?.fit === "contain"
    ? { resizeMode: "contain", inset: sizes.linkIconInset }
    : { resizeMode: "cover", inset: 0 };
}

/** The same rule for the composer's thumbnail, which carries only the marker. */
export function composerThumbnailFit(thumbnailFit: "contain" | undefined) {
  return thumbnailFit === "contain"
    ? { resizeMode: "contain" as const, inset: sizes.linkIconInset }
    : { resizeMode: "cover" as const, inset: 0 };
}
