import { useLingui } from "@lingui/react/macro";
import type { StackImage } from "@rakazo/core";
import { motion, springEasing } from "@rakazo/ui-tokens";
import { cn } from "@rakazo/ui-web";
import { Layers, RotateCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { ImageViewer } from "./image-viewer";
import { useArtifactImageSrc } from "./use-artifact-image-src";

/** Where a stack's size and look come from: nothing here depends on how many images it holds. */
const IMAGE_STACK = {
  /** Cards drawn behind the front one, toward the thread's centre. Their room is always kept. */
  peekLevels: 2,
  /** How far each level shows beyond the front frame's edge, in px. */
  peek: 8,
  /** How much smaller than the front each level is, as a share of its size. */
  shrink: 0.06,
  /** How far above its place a card sits as it starts to land, in px. */
  drop: 12,
  /** The count shows from this many images: a pile of three reads at a glance. */
  countFrom: 4,
} as const;

const STACK_ROOM = IMAGE_STACK.peekLevels * IMAGE_STACK.peek;

type StackCardModel = { key: string; image: StackImage; depth: number };

/** The cards worth mounting, deepest first so the front paints last: the front, those peeking behind it and the one fading out past them. */
function stackCards(images: readonly StackImage[]): StackCardModel[] {
  const cards: StackCardModel[] = [];
  for (let depth = 0; depth <= IMAGE_STACK.peekLevels + 1; depth += 1) {
    const image = images[images.length - 1 - depth];
    if (image) cards.unshift({ key: `${image.messageId}:${image.artifactId}`, image, depth });
  }
  return cards;
}

/** How far a card `depth` levels back sits from the front: its shrink pulls the edge in, `peek` pushes it out. */
function cardTransform(depth: number): string {
  const sideways = `${((depth * IMAGE_STACK.shrink) / 2) * 100}% + ${depth * IMAGE_STACK.peek}px`;
  return `translateX(calc(var(--stack-dir) * (${sideways}))) scale(${1 - depth * IMAGE_STACK.shrink})`;
}

function StackCard({
  target,
  card,
  entering,
  onFront,
}: {
  target: ArtifactTarget;
  card: StackCardModel;
  entering: boolean;
  onFront?: (retry: (() => void) | undefined) => void;
}) {
  const { image, depth } = card;
  // Only the front and the cards peeking behind it load; one that moved on keeps what it loaded.
  const loads = useRef(false);
  if (depth <= IMAGE_STACK.peekLevels) loads.current = true;
  const { container, src, failed, onImageError, retry } = useArtifactImageSrc<HTMLSpanElement>(
    target,
    image.artifactId,
    loads.current,
  );
  const [shown, setShown] = useState(false);

  // A card mounted as the newest image lands on top; one mounted any other time is not an arrival.
  useLayoutEffect(() => {
    const node = container.current;
    if (!entering || !node || typeof node.animate !== "function") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const spring = CSS.supports("animation-timing-function", "linear(0, 1)");
    const animation = node.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, translate: `0 -${IMAGE_STACK.drop}px` },
            { opacity: 1, translate: "0 0" },
          ],
      reduced
        ? { duration: motion.arrive }
        : { duration: motion.flight, easing: spring ? springEasing : motion.ease },
    );
    return () => animation.cancel();
  }, []);

  useEffect(() => {
    if (!onFront) return;
    onFront(failed ? retry : undefined);
    return () => onFront(undefined);
  }, [onFront, failed]);

  return (
    <span
      ref={container}
      data-depth={depth}
      className="absolute inset-0 block overflow-hidden rounded-bubble border border-border bg-muted transition-[transform,opacity] motion-reduce:transition-none"
      style={{
        transform: cardTransform(depth),
        opacity: depth > IMAGE_STACK.peekLevels ? 0 : 1,
        zIndex: IMAGE_STACK.peekLevels + 2 - depth,
        transitionDuration: `${motion.flight}ms`,
        transitionTimingFunction: springEasing,
      }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          onError={onImageError}
          onLoad={() => setShown(true)}
          className={cn(
            "size-full object-cover object-top transition-opacity duration-(--duration-arrive) ease-quiet",
            shown ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
      {failed && depth === 0 ? (
        <span className="absolute inset-0 grid place-items-center text-muted-foreground">
          <RotateCw className="size-5" strokeWidth={1.7} aria-hidden />
        </span>
      ) : null}
    </span>
  );
}

/**
 * A message's images, and those that follow it, as one pile: the newest in a fixed 4:3 frame, up to
 * two earlier ones peeking out toward the thread's centre. The frame and the room for the peeking
 * cards are kept whatever the count, so loading or adding an image never moves the rows around it.
 * A click opens the viewer on the newest; a front that failed to load is retried instead.
 */
export function ImageStack({
  target,
  images,
  side,
  widthCap,
  author,
  label,
}: {
  target: ArtifactTarget;
  /** Oldest to newest: the newest is the front. */
  images: readonly StackImage[];
  /** The person's stack sits at the end and peeks toward the start; a bot's is the other way. */
  side: "user" | "bot";
  /** The width cap of the bubble it stands for, so the side still says who sent it. */
  widthCap: string;
  /** Who sent the images, for the viewer's header. */
  author: string;
  /** What assistive tech says for the image at a position: never its file name. */
  label: (n: number, total: number) => string;
}) {
  const { t } = useLingui();
  const cards = stackCards(images);
  const known = useRef<Set<string> | null>(null);
  known.current ??= new Set(cards.map((card) => card.key));
  useEffect(() => {
    for (const card of cards) known.current?.add(card.key);
  });
  const [retryFront, setRetryFront] = useState<(() => void) | undefined>();
  const reportFront = useCallback((retry: (() => void) | undefined) => {
    setRetryFront(() => retry);
  }, []);
  const [viewer, setViewer] = useState<{
    open: boolean;
    images: readonly StackImage[];
    index: number;
  }>({
    open: false,
    images: [],
    index: 0,
  });
  if (images.length === 0) return null;
  const user = side === "user";

  return (
    <div className={cn("flex w-full", user ? "justify-end" : "justify-start")}>
      <button
        type="button"
        data-slot="image-stack"
        aria-label={label(images.length, images.length)}
        aria-description={retryFront ? t`Retry` : undefined}
        onClick={() => {
          if (retryFront) retryFront();
          else setViewer({ open: true, images, index: images.length - 1 });
        }}
        className={cn(
          "block w-link-card max-w-full rounded-bubble focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          widthCap,
          user ? "[--stack-dir:-1] rtl:[--stack-dir:1]" : "[--stack-dir:1] rtl:[--stack-dir:-1]",
        )}
        style={user ? { paddingInlineStart: STACK_ROOM } : { paddingInlineEnd: STACK_ROOM }}
      >
        <span className="relative block aspect-4/3">
          {cards.map((card) => (
            <StackCard
              key={card.key}
              target={target}
              card={card}
              entering={card.depth === 0 && !known.current?.has(card.key)}
              onFront={card.depth === 0 ? reportFront : undefined}
            />
          ))}
          {images.length >= IMAGE_STACK.countFrom ? (
            <span className="absolute end-2 bottom-2 z-10 flex items-center gap-1 rounded-full bg-overlay px-2 py-1 text-meta text-chat-user-foreground">
              <Layers className="size-3.5" aria-hidden />
              {images.length}
            </span>
          ) : null}
        </span>
      </button>
      <ImageViewer
        open={viewer.open}
        onOpenChange={(open) => setViewer((current) => ({ ...current, open }))}
        target={target}
        images={viewer.images}
        index={viewer.index}
        onIndexChange={(index) => setViewer((current) => ({ ...current, index }))}
        author={author}
        label={label}
      />
    </div>
  );
}
