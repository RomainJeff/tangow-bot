import type { LinkPreviewDraft } from "@rakazo/contracts";
import {
  type ComposerLinkPreviewController,
  type ComposerLinkPreviewView,
  createComposerLinkPreview,
  inferComposerChange,
} from "@rakazo/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { rpc } from "./api";
import { readPageHeadOnDevice } from "./page-head";

/**
 * The composer's link preview for the thread screen: the shared state machine of
 * `@rakazo/core`, fed with the draft. The field cannot tell a paste from typing, so a long
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
        return id
          ? rpc<LinkPreviewDraft | null>(
              "links/preview",
              {
                threadId: id,
                url,
                ...(page
                  ? {
                      pageHead: page.head,
                      ...(page.contentType ? { pageHeadType: page.contentType } : {}),
                    }
                  : {}),
              },
              // The server fetches the image of a device-read page: its own deadline is 10 s.
              { signal, ...(page ? { timeoutMs: 12_000 } : {}) },
            )
          : Promise.resolve(null);
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
