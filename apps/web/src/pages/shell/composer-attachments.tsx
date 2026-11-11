import { useLingui } from "@lingui/react/macro";
import type { LinkPreviewDraft } from "@tangow/contracts";
import { ATTACHMENT_ALLOWED_MIME_TYPES } from "@tangow/contracts";
import type { ComposerChange, ComposerLinkPreviewView, ComposerPageHead } from "@tangow/core";
import { createComposerLinkPreview } from "@tangow/core";
import {
  Button,
  ComposerAttachment,
  ComposerLinkPreview,
  LinkPreviewPicture,
} from "@tangow/ui-web";
import { Plus } from "lucide-react";
import type { DragEvent, RefObject } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { desktopBridge, readPageHeadOnDesktop } from "../../lib/desktop.js";
import { isFileDrag } from "../../lib/pending-attachments";
import type { PendingAttachment } from "./layout";

const ATTACHMENT_ACCEPT = ATTACHMENT_ALLOWED_MIME_TYPES.join(",");

export type PreviewLink = (
  url: string,
  signal: AbortSignal,
  page?: ComposerPageHead,
) => Promise<LinkPreviewDraft | null>;

/** The card for the first complete link of the draft. */
export function useDraftLinkPreview(draft: string, previewLink: PreviewLink | undefined) {
  const previewLinkRef = useRef(previewLink);
  previewLinkRef.current = previewLink;
  const [linkPreview] = useState(() =>
    createComposerLinkPreview({
      read: (url, signal, page) =>
        previewLinkRef.current?.(url, signal, page) ?? Promise.resolve(null),
      // Only the desktop app can read another site's page: a plain browser keeps the server's card.
      ...(desktopBridge()?.pageHead ? { readPageHead: readPageHeadOnDesktop } : {}),
    }),
  );
  const linkPreviewView = useSyncExternalStore(linkPreview.subscribe, linkPreview.getView);
  // What changed the draft, told by the field itself: only a paste says so (a typed or
  // programmatic edit waits for the link to be followed by a space).
  const draftChange = useRef<ComposerChange>("type");
  useEffect(() => {
    linkPreview.update(draft, draftChange.current);
    draftChange.current = "type";
  }, [draft, linkPreview]);
  useEffect(() => () => linkPreview.cancel(), [linkPreview]);
  return { linkPreview, linkPreviewView, draftChange };
}

/** Files dragged onto the composer: the drop highlight and the hand-off to the attachment picker. */
export function useComposerFileDrop({
  disabled,
  onAttachmentPick,
}: {
  disabled: boolean | undefined;
  onAttachmentPick: (files: FileList | null) => void | Promise<void>;
}) {
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);

  function onDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function onDragOver(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    setDraggingFiles(true);
  }

  function onDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function onDrop(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!disabled) void onAttachmentPick(dataTransfer.files);
  }

  return { draggingFiles, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

/** The files and link preview riding along with the draft. */
export function AttachmentTray({
  rewindArtifacts,
  onRemoveRewindArtifact,
  pendingAttachments,
  onRemoveAttachment,
  linkPreview,
  onRemoveLinkPreview,
  disabled,
}: {
  rewindArtifacts?: { id: string; name: string }[];
  onRemoveRewindArtifact?: (artifactId: string) => void;
  pendingAttachments: PendingAttachment[];
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  linkPreview: ComposerLinkPreviewView;
  onRemoveLinkPreview: () => void;
  disabled: boolean;
}) {
  const { t } = useLingui();
  return (
    <>
      {rewindArtifacts?.map((artifact) => (
        <ComposerAttachment
          key={artifact.id}
          name={artifact.name}
          removeLabel={t`Remove ${artifact.name}`}
          onRemove={() => onRemoveRewindArtifact?.(artifact.id)}
          disabled={disabled}
        />
      ))}
      {pendingAttachments.map((attachment) => (
        <ComposerAttachment
          key={attachment.id}
          name={attachment.file.name}
          previewUrl={attachment.previewUrl}
          removeLabel={t`Remove ${attachment.file.name}`}
          onRemove={() => onRemoveAttachment(attachment)}
          disabled={disabled}
        />
      ))}
      {linkPreview.status === "idle" ? null : (
        <ComposerLinkPreview
          site={linkPreview.site}
          title={linkPreview.title}
          image={
            linkPreview.thumbnail ? (
              <LinkPreviewPicture src={linkPreview.thumbnail} fit={linkPreview.thumbnailFit} />
            ) : undefined
          }
          removeLabel={t`Remove preview`}
          onRemove={onRemoveLinkPreview}
          disabled={disabled}
        />
      )}
    </>
  );
}

export function AttachButton({
  inputRef,
  onPick,
  disabled,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onPick: (files: FileList | null) => void | Promise<void>;
  disabled: boolean | undefined;
}) {
  const { t } = useLingui();
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        onChange={(event) => void onPick(event.target.files)}
      />
      <Button
        variant="roundIcon"
        size="roundIcon"
        aria-label={t`Attach file`}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="hover:bg-secondary"
      >
        <Plus size={17} strokeWidth={1.8} />
      </Button>
    </>
  );
}
