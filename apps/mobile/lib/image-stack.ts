import { IMAGE_STACK } from "@rakazo/core";

export type StackFrame = { width: number; height: number };

export function stackFrame(width: number): StackFrame {
  return { width, height: Math.round(width * IMAGE_STACK.frameRatio) };
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
