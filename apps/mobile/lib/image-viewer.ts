import type { StackImage } from "@rakazo/core";
import type { MobileArtifactTarget } from "./artifact-open";

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

export function setImageViewerPayload(next: ImageViewerPayload): void {
  payload = next;
}

export function imageViewerPayload(): ImageViewerPayload | null {
  return payload;
}

export type Size = { width: number; height: number };
export type Rect = Size & { left: number; top: number };

/** The picture fitted whole and centred in `area`, as `contain` draws it. */
export function containRect(area: Size, natural: Size): Rect {
  const scale = Math.min(area.width / natural.width, area.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return { left: (area.width - width) / 2, top: (area.height - height) / 2, width, height };
}
