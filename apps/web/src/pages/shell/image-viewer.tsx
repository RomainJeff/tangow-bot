import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type { StackImage } from "@rakazo/core";
import { IMAGE_STACK, threadTimeMarkerLabel } from "@rakazo/core";
import { Button, cn, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight, RotateCw, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useRef } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useArtifactImageSrc } from "./use-artifact-image-src";

const roundControl =
  "absolute top-1/2 -translate-y-1/2 rounded-full bg-media-backdrop-control text-media-backdrop-foreground hover:bg-media-backdrop-control/80 hover:text-media-backdrop-foreground data-disabled:opacity-40";

/** The enlarged picture of one image, read from the thread's artifacts as the stack's cards are. */
function ViewerPicture({
  target,
  image,
  label,
}: {
  target: ArtifactTarget;
  image: StackImage;
  label: string;
}) {
  const { t } = useLingui();
  const { container, src, failed, onImageError, retry } = useArtifactImageSrc(
    target,
    image.artifactId,
  );
  return (
    <div ref={container} className="flex size-full items-center justify-center">
      {failed ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Retry`}
          onClick={retry}
          className="text-media-backdrop-muted hover:bg-media-backdrop-control hover:text-media-backdrop-foreground"
        >
          <RotateCw aria-hidden />
        </Button>
      ) : src ? (
        <img
          src={src}
          alt={label}
          onError={onImageError}
          className="max-h-full max-w-full rounded-card object-contain"
        />
      ) : (
        <div
          className="h-full max-w-full rounded-card bg-media-backdrop-control"
          style={{ aspectRatio: 1 / IMAGE_STACK.frameRatio }}
        />
      )}
    </div>
  );
}

/** One image in the viewer's strip: a click shows it, the current one is ringed and kept in view. */
function ViewerThumb({
  target,
  image,
  label,
  current,
  onSelect,
}: {
  target: ArtifactTarget;
  image: StackImage;
  label: string;
  current: boolean;
  onSelect: () => void;
}) {
  const { container, src, onImageError } = useArtifactImageSrc<HTMLButtonElement>(
    target,
    image.artifactId,
  );
  const opening = useRef(true);
  useEffect(() => {
    const instant =
      opening.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    opening.current = false;
    if (!current) return;
    container.current?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: instant ? "instant" : "smooth",
    });
  }, [current]);
  return (
    <button
      ref={container}
      type="button"
      aria-label={label}
      aria-current={current || undefined}
      onClick={onSelect}
      className={cn(
        "size-viewer-thumb shrink-0 overflow-hidden rounded-row bg-media-backdrop-control transition-opacity duration-(--duration-hover) ease-quiet focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-media-backdrop-foreground",
        current ? "ring-selected ring-media-backdrop-foreground" : "opacity-60 hover:opacity-100",
      )}
    >
      {src ? (
        <img
          src={src}
          alt=""
          onError={onImageError}
          className="size-full object-cover object-top"
        />
      ) : null}
    </button>
  );
}

/**
 * A stack's images, one at a time, on the media backdrop. The list is the stack as it was when
 * opened, from its front down (newest to oldest): an image arriving meanwhile never changes it.
 * With more than one, a strip of thumbnails under the image jumps to any of them. Escape and the focus returning to the
 * stack come from `Dialog`.
 */
export function ImageViewer({
  open,
  onOpenChange,
  target,
  images,
  index,
  onIndexChange,
  author,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ArtifactTarget;
  images: readonly StackImage[];
  index: number;
  onIndexChange: (index: number) => void;
  author: string;
  /** What assistive tech says for the image at a position: never its file name. */
  label: (n: number, total: number) => string;
}) {
  const { t } = useLingui();
  const image = images[index];
  if (!image) return null;
  const step = (by: -1 | 1) => onIndexChange(Math.min(Math.max(index + by, 0), images.length - 1));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
  };
  const current = label(index + 1, images.length);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={onKeyDown}
        className="w-[90vw] max-w-5xl bg-media-backdrop p-3 text-media-backdrop-foreground sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">{current}</DialogTitle>
        <div className="flex items-start justify-between gap-3 ps-1">
          <div className="min-w-0 text-meta">
            <div className="truncate" dir="auto">
              {author}
            </div>
            <time dateTime={image.ts} className="text-time text-media-backdrop-muted">
              {threadTimeMarkerLabel(image.ts, {
                locale: i18n.locale || "en",
                today: t`Today`,
                yesterday: t`Yesterday`,
                withTime: true,
              })}
            </time>
          </div>
          <DialogClose
            aria-label={t`Close image preview`}
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-media-backdrop-foreground hover:bg-media-backdrop-control hover:text-media-backdrop-foreground"
              />
            }
          >
            <X />
          </DialogClose>
        </div>
        <div className="relative h-[70vh]">
          <ViewerPicture
            key={`${image.messageId}:${image.artifactId}`}
            target={target}
            image={image}
            label={current}
          />
          {images.length > 1 ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t`Previous image`}
                disabled={index === 0}
                focusableWhenDisabled
                onClick={() => step(-1)}
                className={cn(roundControl, "start-2")}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t`Next image`}
                disabled={index === images.length - 1}
                focusableWhenDisabled
                onClick={() => step(1)}
                className={cn(roundControl, "end-2")}
              >
                <ChevronRight />
              </Button>
            </>
          ) : null}
        </div>
        {images.length > 1 ? (
          <div className="mx-auto flex w-fit max-w-full gap-2 overflow-x-auto p-1">
            {images.map((item, i) => (
              <ViewerThumb
                key={`${item.messageId}:${item.artifactId}`}
                target={target}
                image={item}
                label={label(i + 1, images.length)}
                current={i === index}
                onSelect={() => onIndexChange(i)}
              />
            ))}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
