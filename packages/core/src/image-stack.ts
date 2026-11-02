import type { StackImage } from "./session-log/project-thread-view.js";

/** Where a stack of images gets its size and look, on every surface: nothing here depends on how many images it holds. */
export const IMAGE_STACK = {
  /** The front frame's height over its width, 4:3 whatever the image. */
  frameRatio: 3 / 4,
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

/** The room the cards behind take beside the front frame. */
export const STACK_ROOM = IMAGE_STACK.peekLevels * IMAGE_STACK.peek;

/**
 * How far one level of depth moves a card sideways: its shrink pulls the edge in (a share of the
 * frame's width), `peek` pushes it out (px). Surfaces that know the width in px use `stackStepX`.
 */
export const STACK_STEP = { widthShare: IMAGE_STACK.shrink / 2, px: IMAGE_STACK.peek } as const;

export function stackStepX(frameWidth: number): number {
  return frameWidth * STACK_STEP.widthShare + STACK_STEP.px;
}

/** An image drawn `depth` cards behind the front one (0 is the front). `key` follows the image as it moves back. */
export type StackCardModel = { key: string; image: StackImage; depth: number };

/** The cards worth mounting, deepest first so the front paints last: the front, the cards peeking behind it and the one fading out past them. */
export function stackCards(images: readonly StackImage[]): StackCardModel[] {
  const cards: StackCardModel[] = [];
  for (let depth = 0; depth <= IMAGE_STACK.peekLevels + 1; depth += 1) {
    const image = images[images.length - 1 - depth];
    if (image) cards.unshift({ key: `${image.messageId}:${image.artifactId}`, image, depth });
  }
  return cards;
}
