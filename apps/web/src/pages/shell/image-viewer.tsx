import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import type { StackImage } from "@rakazo/core";
import { threadTimeMarkerLabel } from "@rakazo/core";
import { Button, cn, Dialog, DialogClose, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { ChevronLeft, ChevronRight, RotateCw, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useArtifactImageSrc } from "./use-artifact-image-src";

const roundControl =
  "absolute top-1/2 -translate-y-1/2 rounded-full bg-media-backdrop-control text-media-backdrop-foreground hover:bg-media-backdrop-control/80 hover:text-media-backdrop-foreground disabled:opacity-40";

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
    <div ref={container} className="grid size-full place-items-center">
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
      ) : null}
    </div>
  );
}

/**
 * A stack's images, one at a time, on the media backdrop. The list is the stack as it was when
 * opened (oldest to newest): an image arriving meanwhile never changes it. Escape and the focus
 * returning to the stack come from `Dialog`.
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
                onClick={() => step(1)}
                className={cn(roundControl, "end-2")}
              >
                <ChevronRight />
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
