import * as z from "zod";
import { Id } from "./ids.js";

export const LINK_PREVIEW_URL_MAX_LENGTH = 2048;
export const LINK_PREVIEW_TITLE_MAX_LENGTH = 300;
/** The longest start of a page (up to `</head>`) a device may send, in characters (one per byte). */
export const LINK_PREVIEW_PAGE_HEAD_MAX_LENGTH = 512 * 1024;
/** The Content-Type that came with that head. */
export const LINK_PREVIEW_PAGE_HEAD_TYPE_MAX_LENGTH = 200;
export const LINK_PREVIEW_THUMBNAIL_PREFIX = "data:image/webp;base64,";
/**
 * Length cap of the composer thumbnail's data URL, in characters: base64 adds a third, so 70 000
 * characters hold about 50 KiB of WebP bytes. This is the client-side ceiling; the server encodes
 * well under it (`MAX_THUMBNAIL_DATA_URL_LENGTH` in the adapters).
 */
export const LINK_PREVIEW_THUMBNAIL_MAX_LENGTH = 70_000;

/**
 * A URL a preview may ever be read for or rendered as a link: http(s) only, bounded, and without
 * credentials. Single source of truth for the block contract and the first-link extraction, so
 * a scheme such as `javascript:` or `itms-services:` can never become a clickable card.
 */
export function isPreviewableUrl(value: string): boolean {
  if (value.length > LINK_PREVIEW_URL_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

const PreviewUrl = z.string().refine(isPreviewableUrl, "Expected a public http(s) URL");

/**
 * How a client fits a preview image in its frame. Absent means it fills the frame, cropped at the
 * center. `contain` marks a site icon: shown whole, centered, with a small inset. Optional, so a
 * block stored before it existed stays valid and an older client simply crops.
 */
export const LINK_PREVIEW_IMAGE_FIT = "contain";

const LinkPreviewImage = z.object({
  artifactId: Id,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fit: z.literal(LINK_PREVIEW_IMAGE_FIT).optional(),
});

/**
 * One block, two shapes under the same `kind`: the preview card, and the tombstone left when it
 * was removed (it renders nothing and keeps the preview from ever being added back). A
 * discriminated union cannot hold two options with one discriminator value, so the shapes are
 * told apart by `removed` and `isLinkPreviewCard` narrows. The site shown is derived from `url`,
 * never stored, and there is deliberately no `text` field: blocks with `text` fall back into
 * model history.
 */
export const LinkPreviewBlock = z
  .object({
    kind: z.literal("link_preview"),
    url: PreviewUrl.optional(),
    removed: z.literal(true).optional(),
    format: z.enum(["large", "photo", "compact"]).optional(),
    title: z.string().max(LINK_PREVIEW_TITLE_MAX_LENGTH).optional(),
    image: LinkPreviewImage.optional(),
  })
  .superRefine((block, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", message, path: [path] });
    if (block.removed) {
      for (const field of ["format", "title", "image"] as const) {
        if (block[field] !== undefined) issue(field, "A removed preview carries only its url");
      }
      return;
    }
    if (!block.url) issue("url", "A preview needs a url");
    if (!block.format) return issue("format", "A preview needs a format");
    if (block.format !== "compact" && !block.image) issue("image", "This format needs an image");
    if (block.image?.fit && block.format !== "compact") {
      issue("image", "Only a compact preview carries a site icon");
    }
    if (block.format !== "photo" && !block.title) issue("title", "This format needs a title");
  });
export type LinkPreviewBlock = z.infer<typeof LinkPreviewBlock>;

export type LinkPreviewCard = {
  kind: "link_preview";
  url: string;
  format: "large" | "photo" | "compact";
  title?: string;
  image?: z.infer<typeof LinkPreviewImage>;
};

/** True for a preview that has something to show, false for the removal marker. */
export function isLinkPreviewCard(block: LinkPreviewBlock): block is LinkPreviewCard {
  return !block.removed && block.url !== undefined && block.format !== undefined;
}

/** Answer of `links.preview` for the composer: no artifact, the thumbnail travels inline. */
export const LinkPreviewDraftSchema = z.object({
  format: z.enum(["large", "photo", "compact"]),
  title: z.string().max(LINK_PREVIEW_TITLE_MAX_LENGTH).optional(),
  thumbnail: z
    .string()
    .max(LINK_PREVIEW_THUMBNAIL_MAX_LENGTH)
    .refine((value) => value.startsWith(LINK_PREVIEW_THUMBNAIL_PREFIX), "Expected a WebP data URL")
    .optional(),
  /** `contain` when the thumbnail is a site icon: drawn whole, not cropped. */
  thumbnailFit: z.literal(LINK_PREVIEW_IMAGE_FIT).optional(),
  /**
   * True when the site refused the server (or answered with a passing 429 or 5xx) and the
   * sender's own device may read the page and send its head back as `pageHead`. It says nothing
   * more: a refused address, a missing page or a limit never set it. A draft with no title and
   * no thumbnail shows nothing; it is how a refusal with no usable fallback carries this flag.
   */
  deviceReadable: z.literal(true).optional(),
});
export type LinkPreviewDraft = z.infer<typeof LinkPreviewDraftSchema>;
