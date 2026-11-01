import type { StackImage } from "@rakazo/core";

/** Where an image stack's size and look come from: nothing here depends on how many images it holds. */
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
} as const;

export type StackFrame = { width: number; height: number };

export function stackFrame(width: number): StackFrame {
  return { width, height: Math.round(width * IMAGE_STACK.frameRatio) };
}

/** The room the cards behind take beside the front frame. */
export const STACK_ROOM = IMAGE_STACK.peekLevels * IMAGE_STACK.peek;

/** How far one level of depth moves a card sideways: its shrink pulls the edge in, `peek` pushes it out. */
export function stackStepX(frameWidth: number): number {
  return (frameWidth * IMAGE_STACK.shrink) / 2 + IMAGE_STACK.peek;
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

/** The picture scaled to fill the frame, its top edge on the frame's top: the bottom is what gets cropped. */
export function coverFromTop(
  frame: StackFrame,
  natural: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const scale = Math.max(frame.width / natural.width, frame.height / natural.height);
  const width = natural.width * scale;
  return { left: (frame.width - width) / 2, top: 0, width, height: natural.height * scale };
}
