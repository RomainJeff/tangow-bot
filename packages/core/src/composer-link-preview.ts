import type { LinkPreviewDraft } from "@rakazo/contracts";
import {
  LINK_PREVIEW_IMAGE_FIT,
  LINK_PREVIEW_THUMBNAIL_MAX_LENGTH,
  LINK_PREVIEW_THUMBNAIL_PREFIX,
} from "@rakazo/contracts";
import {
  firstEligibleLink,
  hasSecretParam,
  isAuthenticationDestination,
  previewSiteLabel,
  sanitizePreviewTitle,
} from "./link-preview.js";

/** How long a complete link must stay the first link before the page is read. */
export const COMPOSER_LINK_PREVIEW_DEBOUNCE_MS = 800;

/** What changed the draft: a person typing (or any programmatic edit), or a paste. */
export type ComposerChange = "type" | "paste";

/** An insertion at least this long, in one change, is a paste on a keyboard that does not say so. */
const PASTE_MIN_INSERTED = 8;

/** The span of `next` that is not in `prev`: what a single edit inserted. */
function insertedSpan(prev: string, next: string): { start: number; end: number } {
  const max = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < max && prev[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { start: prefix, end: next.length - suffix };
}

/** For a field that cannot tell a paste from typing (iOS): a long insertion in one change is one. */
export function inferComposerChange(prev: string, next: string): ComposerChange {
  const { start, end } = insertedSpan(prev, next);
  return end - start >= PASTE_MIN_INSERTED ? "paste" : "type";
}

/**
 * The link of `next` that is ready to be read, or undefined. The first eligible link must be
 * complete: pasted, or its word followed by a space or a line break. A link still being typed
 * (nothing after it yet) never is, and neither is a link with a secret in its query or one to a sign-in page.
 */
export function composerLinkPreviewTrigger(
  prev: string,
  next: string,
  change: ComposerChange,
): string | undefined {
  const link = firstEligibleLink(next);
  if (!link || hasSecretParam(link) || isAuthenticationDestination(link)) return undefined;
  const pasted = change === "paste" ? insertedSpan(prev, next) : undefined;
  for (let at = next.indexOf(link); at !== -1; at = next.indexOf(link, at + 1)) {
    const linkEnd = at + link.length;
    if (pasted && at < pasted.end && linkEnd > pasted.start) return link;
    // The word the link sits in (a trailing `.` or `>` belongs to it) must be followed by a space.
    const word = /\s/u.exec(next.slice(linkEnd));
    if (word) return link;
  }
  return undefined;
}

/**
 * The thumbnail the composer may draw: a WebP data URL of bounded size and only base64
 * characters. Anything else (an http(s) URL above all) is no image: the composer never makes
 * a request on a page's behalf.
 */
export function acceptPreviewThumbnail(value: string | undefined): string | undefined {
  if (!value?.startsWith(LINK_PREVIEW_THUMBNAIL_PREFIX)) return undefined;
  if (value.length > LINK_PREVIEW_THUMBNAIL_MAX_LENGTH) return undefined;
  const payload = value.slice(LINK_PREVIEW_THUMBNAIL_PREFIX.length);
  return /^[A-Za-z0-9+/]+={0,2}$/.test(payload) ? value : undefined;
}

export type ComposerLinkPreviewView =
  | { status: "idle" }
  | { status: "loading"; url: string }
  | {
      status: "ready";
      url: string;
      site: string;
      title?: string;
      thumbnail?: string;
      /** `contain` when the thumbnail is a site icon: drawn whole, not cropped. */
      thumbnailFit?: typeof LINK_PREVIEW_IMAGE_FIT;
    };

const IDLE: ComposerLinkPreviewView = { status: "idle" };

export interface ComposerLinkPreviewDeps {
  /** Reads the page for `url`; null (or a throw) means there is nothing to show. */
  read: (url: string, signal: AbortSignal) => Promise<LinkPreviewDraft | null>;
  debounceMs?: number;
}

export interface ComposerLinkPreviewController {
  /** The draft changed. An empty draft starts over. */
  update(next: string, change?: ComposerChange): void;
  /** The person took the preview off: this message gets none, whatever its links become. */
  remove(): void;
  /** The message was sent or the draft thrown away. */
  reset(): void;
  /** True once the person removed the preview of the current draft: send `linkPreview: false`. */
  isRemoved(): boolean;
  /** Stops any pending or running read; the controller stays usable. */
  cancel(): void;
  getView(): ComposerLinkPreviewView;
  subscribe(listener: () => void): () => void;
}

/**
 * The composer's link preview, one state machine for every surface. It reads only when the
 * first eligible link of the draft is complete, 800 ms after it became the first link, and drops
 * the read when that link changes or goes away. A failure, a null answer or a draft that has
 * moved on leaves nothing on screen and no message. Removing the preview is for the draft: no
 * read is made for it again until the draft is emptied or sent.
 */
export function createComposerLinkPreview(
  deps: ComposerLinkPreviewDeps,
): ComposerLinkPreviewController {
  const debounceMs = deps.debounceMs ?? COMPOSER_LINK_PREVIEW_DEBOUNCE_MS;
  const listeners = new Set<() => void>();
  let text = "";
  let view: ComposerLinkPreviewView = IDLE;
  /** The link a timer, a read or a card is for. */
  let link: string | undefined;
  let removed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;

  const show = (next: ComposerLinkPreviewView) => {
    if (next === view) return;
    view = next;
    for (const listener of [...listeners]) listener();
  };

  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    abort?.abort();
    abort = undefined;
  };

  const start = (url: string) => {
    const controller = new AbortController();
    abort = controller;
    timer = setTimeout(() => {
      timer = undefined;
      show({ status: "loading", url });
      deps.read(url, controller.signal).then(
        (draft) => {
          if (controller.signal.aborted) return;
          const title = draft?.title ? sanitizePreviewTitle(draft.title) : "";
          const thumbnail = acceptPreviewThumbnail(draft?.thumbnail);
          show(
            title || thumbnail
              ? {
                  status: "ready",
                  url,
                  site: previewSiteLabel(url),
                  ...(title ? { title } : {}),
                  ...(thumbnail ? { thumbnail } : {}),
                  ...(thumbnail && draft?.thumbnailFit === LINK_PREVIEW_IMAGE_FIT
                    ? { thumbnailFit: LINK_PREVIEW_IMAGE_FIT }
                    : {}),
                }
              : IDLE,
          );
        },
        () => {
          if (!controller.signal.aborted) show(IDLE);
        },
      );
    }, debounceMs);
  };

  const reset = () => {
    stop();
    link = undefined;
    removed = false;
    show(IDLE);
  };

  return {
    update(next, change = "type") {
      const prev = text;
      text = next;
      if (next.trim() === "") return reset();
      if (removed) return;
      const target = composerLinkPreviewTrigger(prev, next, change);
      if (target === link) return;
      stop();
      link = target;
      show(IDLE);
      if (target) start(target);
    },
    remove() {
      stop();
      link = undefined;
      removed = true;
      show(IDLE);
    },
    reset() {
      text = "";
      reset();
    },
    isRemoved: () => removed,
    cancel() {
      stop();
      link = undefined;
      show(IDLE);
    },
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
