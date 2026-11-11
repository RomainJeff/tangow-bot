import { inferAttachmentMimeType } from "@tangow/core";

export const MAX_WIDGET_IMAGE_BYTES = 1024 * 1024;

const SRC_ATTRIBUTE = /(\ssrc\s*=\s*)(["'])([^"']*)\2/gi;

const isComputerPath = (value: string) =>
  (value.startsWith("/") && !value.startsWith("//")) || value.startsWith("~/");

export async function inlineWidgetImages(
  html: string,
  readImage: (path: string) => Promise<Uint8Array>,
): Promise<{ html: string } | { error: string }> {
  const paths = new Set<string>();
  for (const match of html.matchAll(SRC_ATTRIBUTE)) {
    if (isComputerPath(match[3]!)) paths.add(match[3]!);
  }
  if (paths.size === 0) return { html };
  const dataUrls = new Map<string, string>();
  for (const path of paths) {
    const mimeType = inferAttachmentMimeType(path);
    if (!mimeType?.startsWith("image/")) return { error: `Not an image: ${path}` };
    let bytes: Uint8Array;
    try {
      bytes = await readImage(path);
    } catch (error) {
      const tooBig = error instanceof Error && /exceeds \d+ bytes/.test(error.message);
      return { error: tooBig ? `Image over the 1 MiB limit: ${path}` : `Image not found: ${path}` };
    }
    if (bytes.byteLength > MAX_WIDGET_IMAGE_BYTES) {
      return { error: `Image over the 1 MiB limit: ${path}` };
    }
    dataUrls.set(path, `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`);
  }
  return {
    html: html.replace(SRC_ATTRIBUTE, (whole, prefix: string, quote: string, value: string) => {
      const dataUrl = dataUrls.get(value);
      return dataUrl ? `${prefix}${quote}${dataUrl}${quote}` : whole;
    }),
  };
}
