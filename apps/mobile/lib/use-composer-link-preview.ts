import type { LinkPreviewDraft } from "@tangow/contracts";
import { LINK_PREVIEW_COMPOSER_DEADLINE_MS } from "@tangow/contracts";
import {
  type ComposerLinkPreviewController,
  type ComposerLinkPreviewView,
  type ComposerPageHead,
  createComposerLinkPreview,
  inferComposerChange,
} from "@tangow/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { rpc } from "./api";
import { readPageHeadOnDevice } from "./page-head";

export function previewComposerLink(
  threadId: string,
  url: string,
  signal: AbortSignal,
  page?: ComposerPageHead,
) {
  return rpc<LinkPreviewDraft | null>(
    "links/preview",
    {
      threadId,
      url,
      ...(page
        ? {
            pageHead: page.head,
            ...(page.contentType ? { pageHeadType: page.contentType } : {}),
          }
        : {}),
    },
    // Past the server's own deadline, so a slow site still answers `deviceReadable`.
    { signal, timeoutMs: LINK_PREVIEW_COMPOSER_DEADLINE_MS + 2_000 },
  );
}

/**
 * The composer's link preview for the thread screen: the shared state machine of
 * `@tangow/core`, fed with the draft. The field cannot tell a paste from typing, so a long
 * insertion in one change counts as one.
 */
export function useComposerLinkPreview(
  draft: string,
  threadId: string | undefined,
): { view: ComposerLinkPreviewView; controller: ComposerLinkPreviewController } {
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  const [controller] = useState(() =>
    createComposerLinkPreview({
      read: (url, signal, page) => {
        const id = threadIdRef.current;
        return id ? previewComposerLink(id, url, signal, page) : Promise.resolve(null);
      },
      // The phone reads the page only for a site that refused the server (`deviceReadable`).
      readPageHead: readPageHeadOnDevice,
    }),
  );
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const previous = useRef("");
  useEffect(() => {
    controller.update(draft, inferComposerChange(previous.current, draft));
    previous.current = draft;
  }, [draft, controller]);
  useEffect(() => () => controller.cancel(), [controller]);
  return { view, controller };
}
