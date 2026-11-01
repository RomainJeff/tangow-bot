import type { StackImage } from "@rakazo/core";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { MobileArtifactTarget } from "./artifact-open";
import { useChatReducedMotion } from "./chat-motion";
import type { t as Translate } from "./i18n";

/** Where the viewer route lives: the stack's link navigates here so the zoom transition can attach. */
export const IMAGE_VIEWER_HREF = "/image-viewer";

/** What a tap on a stack hands the viewer. The list is the stack as it was when opened; a later arrival never changes it. */
export type ImageViewerPayload = {
  /** Oldest to newest. */
  images: readonly StackImage[];
  startIndex: number;
  author: string;
  target: MobileArtifactTarget;
};

let payload: ImageViewerPayload | null = null;
let threadHeld = false;
const listeners = new Set<() => void>();

function holdThread(held: boolean): void {
  if (threadHeld === held) return;
  threadHeld = held;
  for (const listener of listeners) listener();
}

/**
 * Hands the viewer what to show. `holdThread` is for a tap on a stack in the thread: the viewer opens
 * out of that stack, so the thread keeps its rows until `releaseImageViewer`.
 */
export function setImageViewerPayload(
  next: ImageViewerPayload,
  options?: { holdThread?: boolean },
): void {
  payload = next;
  if (options?.holdThread) holdThread(true);
}

export function imageViewerPayload(): ImageViewerPayload | null {
  return payload;
}

/**
 * The viewer is gone, which is after the system has finished closing it. The thread is let go a
 * frame later, once the zoom source is on screen again.
 */
export function releaseImageViewer(): void {
  payload = null;
  requestAnimationFrame(() => holdThread(false));
}

/** True from a tap on a thread stack until its viewer has closed: the thread draws the rows it had. */
export function useThreadHeldByImageViewer(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => threadHeld,
  );
}

/** What assistive tech says for the image at position `n` of a stack: never its file name. */
export function imageLabel(t: typeof Translate, n: number, total: number, author: string): string {
  return total > 1
    ? t("Image {n} of {total}, from {author}", { n, total, author })
    : t("Image, from {author}", { author });
}

export function imageKey(image: StackImage): string {
  return `${image.messageId}:${image.artifactId}`;
}

/**
 * Whether the viewer opens and closes with the system's zoom transition, whose own drag-down
 * closes it: iOS 18 and later, and not under Reduce Motion. Without it the viewer closes by its
 * own drag.
 */
export function useImageZoom(): boolean {
  const reducedMotion = useChatReducedMotion();
  return (
    !reducedMotion && Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 18
  );
}

/** Where dragging the viewer down closes it: far enough, or fast enough. */
export const CLOSE_DISTANCE = 120;
export const CLOSE_VELOCITY = 800;

export type Size = { width: number; height: number };
export type Rect = Size & { left: number; top: number };

/** The picture fitted whole and centred in `area`, as `contain` draws it. */
export function containRect(area: Size, natural: Size): Rect {
  const scale = Math.min(area.width / natural.width, area.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { left: (area.width - width) / 2, top: (area.height - height) / 2, width, height };
}
