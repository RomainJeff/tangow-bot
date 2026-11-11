import type { LinkPreviewDraft } from "@tangow/contracts";
import {
  LINK_PREVIEW_IMAGE_FIT,
  LINK_PREVIEW_THUMBNAIL_MAX_LENGTH,
  LINK_PREVIEW_THUMBNAIL_PREFIX,
} from "@tangow/contracts";
import { linkMentionCandidates, previewSiteLabel, sanitizePreviewTitle } from "./link-preview.js";
import { extractLinkOccurrences } from "./search.js";

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
 * The link of `next` that is ready to be read, or undefined. The first eligible link (the one a
 * card may go with) must be complete: pasted, or its word followed by a space or a line break. A
 * link still being typed (nothing after it yet) never is.
 */
export function composerLinkPreviewTrigger(
  prev: string,
  next: string,
  change: ComposerChange,
): string | undefined {
  const link = cardCandidate(next);
  if (!link) return undefined;
  const pasted = change === "paste" ? insertedSpan(prev, next) : undefined;
  for (const { href, start, end } of extractLinkOccurrences(next)) {
    if (href !== link) continue;
    if (pasted && start < pasted.end && end > pasted.start) return link;
    // The word the link sits in (a trailing `.` or `>` belongs to it) must be followed by a space.
    if (/\s/u.test(next.slice(end))) return link;
  }
  return undefined;
}

function cardCandidate(text: string): string | undefined {
  return linkMentionCandidates(text)[0]?.url;
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

/** The start of a page as the device read it, with the Content-Type it came with. */
export interface ComposerPageHead {
  head: string;
  contentType?: string;
}

export interface ComposerLinkPreviewDeps {
  /**
   * Reads the page for `url` on the server; null (or a throw) means there is nothing to show.
   * `page` is what the sender's own device read, given only after a draft said `deviceReadable`.
   */
  read: (
    url: string,
    signal: AbortSignal,
    page?: ComposerPageHead,
  ) => Promise<LinkPreviewDraft | null>;
  /**
   * Native shells only (iOS, the desktop app): reads the start of the page on this device, for a
   * site that refuses the server. Absent in a browser, which cannot read another site. Null, a
   * throw or an empty head mean the page could not be read: the server's draft stays.
   */
  readPageHead?: (url: string, signal: AbortSignal) => Promise<ComposerPageHead | null | undefined>;
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
 * read is made for it again until the draft is emptied or sent. A native shell may also give it
 * `readPageHead`, used only when the server's draft says the page is `deviceReadable`.
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

  /** The card a draft makes, or undefined when it holds nothing to show. */
  const readyView = (
    url: string,
    draft: LinkPreviewDraft | null,
  ): ComposerLinkPreviewView | undefined => {
    const title = draft?.title ? sanitizePreviewTitle(draft.title) : "";
    const thumbnail = acceptPreviewThumbnail(draft?.thumbnail);
    if (!title && !thumbnail) return undefined;
    return {
      status: "ready",
      url,
      site: previewSiteLabel(url),
      ...(title ? { title } : {}),
      ...(thumbnail ? { thumbnail } : {}),
      ...(thumbnail && draft?.thumbnailFit === LINK_PREVIEW_IMAGE_FIT
        ? { thumbnailFit: LINK_PREVIEW_IMAGE_FIT }
        : {}),
    };
  };

  /**
   * The server's draft first: a card only when it holds one. When it says the site refused the
   * server and this device can read pages, the device reads the head and the server is asked
   * again with it. Nothing shows while a read runs, and any failure leaves nothing on screen.
   */
  const load = async (url: string, signal: AbortSignal) => {
    let first: LinkPreviewDraft | null = null;
    try {
      first = await deps.read(url, signal);
    } catch {
      first = null;
    }
    if (signal.aborted) return;
    const readPageHead = deps.readPageHead;
    if (!first?.deviceReadable || !readPageHead) return show(readyView(url, first) ?? IDLE);
    let upgraded: ComposerLinkPreviewView | undefined;
    try {
      const page = await readPageHead(url, signal);
      if (page?.head && !signal.aborted) {
        upgraded = readyView(url, await deps.read(url, signal, page));
      }
    } catch {
      upgraded = undefined;
    }
    if (signal.aborted) return;
    show(upgraded ?? IDLE);
  };

  const start = (url: string) => {
    const controller = new AbortController();
    abort = controller;
    timer = setTimeout(() => {
      timer = undefined;
      void load(url, controller.signal);
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
      // Only a new link must be complete: typing elsewhere in the draft keeps the current one.
      if (link && cardCandidate(next) === link) return;
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
