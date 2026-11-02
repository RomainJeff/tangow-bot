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
  /** Newest to oldest, as the stack is piled: the viewer opens on the first. */
  images: readonly StackImage[];
  author: string;
  target: MobileArtifactTarget;
  /**
   * The viewer opened through the stack's zoom link, so the system's transition (and its drag
   * down) closes it, and it holds the thread's rows while it is on screen. Otherwise it closes by
   * its own drag.
   */
  zoomed?: boolean;
};

let payload: ImageViewerPayload | null = null;
let holds = 0;
const listeners = new Set<() => void>();

function changeHolds(by: 1 | -1): void {
  holds += by;
  for (const listener of listeners) listener();
}

export function setImageViewerPayload(next: ImageViewerPayload): void {
  payload = next;
}

export function imageViewerPayload(): ImageViewerPayload | null {
  return payload;
}

export function clearImageViewerPayload(): void {
  payload = null;
}

/**
 * How long the thread stays held after the viewer unmounts. Closing with the X unmounts it as the
 * system's dismissal starts, and the zoom source stays hidden until that animation ends.
 */
const HOLD_AFTER_CLOSE_MS = 700;

/**
 * The thread keeps its rows from the moment the viewer is on screen. The returned release is for
 * when the viewer has unmounted, and lets the thread go once the dismissal has finished and the
 * zoom source is on screen again. Each viewer holds once, so a second one never releases the first's
 * hold.
 */
export function holdThreadForViewer(): () => void {
  changeHolds(1);
  return () => {
    setTimeout(() => changeHolds(-1), HOLD_AFTER_CLOSE_MS);
  };
}

/** True while a viewer opened from the thread is on screen: the thread draws the rows it had. */
export function useThreadHeldByImageViewer(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => holds > 0,
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
