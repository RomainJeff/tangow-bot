import type sharpModule from "sharp";
import { LinkPreviewError } from "./errors.js";
import { processEncodeSemaphore, type Semaphore } from "./limits.js";

export const MAX_INPUT_PIXELS = 25_000_000;
export const MAX_PREVIEW_IMAGE_WIDTH = 1200;
export const MAX_PREVIEW_IMAGE_BYTES = 400 * 1024;
/** Length cap of the thumbnail data URL as a whole, prefix and base64 included. */
export const MAX_THUMBNAIL_DATA_URL_LENGTH = 50 * 1024;
export const IMAGE_ENCODE_TIMEOUT_MS = 8_000;

const WEBP_QUALITIES = [80, 55];
const THUMBNAIL_WIDTHS = [320, 240, 160, 96];
const THUMBNAIL_QUALITY = 70;

/** No AVIF (decoder attack surface) and no SVG (scriptable): four raster formats only. */
type AllowedFormat = "jpeg" | "png" | "webp" | "gif";

export interface EncodedPreviewImage {
  bytes: Buffer;
  width: number;
  height: number;
}

export interface ImageEncodeOptions {
  timeoutMs?: number;
  semaphore?: Semaphore;
}

/**
 * Re-encode a downloaded image as a WebP card image: first frame only, EXIF orientation applied
 * then all metadata dropped, 1200 px wide at most. Throws only `LinkPreviewError`
 * (`unsupported_type`, `too_large`, `timeout`).
 */
export async function encodePreviewImage(
  input: Uint8Array,
  options: ImageEncodeOptions = {},
): Promise<EncodedPreviewImage> {
  const magic = sniffFormat(input);
  if (!magic) throw new LinkPreviewError("unsupported_type");
  return runEncode(options, async (sharp) => {
    const open = () =>
      sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", pages: 1 });
    const metadata = await open().metadata();
    if (metadata.format !== magic) throw new LinkPreviewError("unsupported_type");
    for (const quality of WEBP_QUALITIES) {
      const { data, info } = await open()
        .rotate()
        .resize({ width: MAX_PREVIEW_IMAGE_WIDTH, withoutEnlargement: true })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });
      if (data.byteLength <= MAX_PREVIEW_IMAGE_BYTES) {
        return { bytes: data, width: info.width, height: info.height };
      }
    }
    throw new LinkPreviewError("too_large");
  });
}

/** A `data:image/webp;base64,…` thumbnail of an already re-encoded preview image, for the composer. */
export async function createThumbnailDataUrl(
  webp: Uint8Array,
  options: ImageEncodeOptions = {},
): Promise<string> {
  return runEncode(options, async (sharp) => {
    for (const width of THUMBNAIL_WIDTHS) {
      const data = await sharp(webp)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: THUMBNAIL_QUALITY })
        .toBuffer();
      const url = `data:image/webp;base64,${data.toString("base64")}`;
      if (url.length <= MAX_THUMBNAIL_DATA_URL_LENGTH) return url;
    }
    throw new LinkPreviewError("too_large");
  });
}

type Sharp = typeof sharpModule;

/** Holds an encode slot until the work really ends, even when the caller gave up on the timeout. */
async function runEncode<T>(
  options: ImageEncodeOptions,
  work: (sharp: Sharp) => Promise<T>,
): Promise<T> {
  const semaphore = options.semaphore ?? processEncodeSemaphore;
  const job = semaphore.run(async () => work((await import("sharp")).default));
  // The race below can abandon `job`: its rejection must not go unhandled.
  job.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      job.catch((error: unknown) => {
        throw toImageError(error);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LinkPreviewError("timeout")),
          options.timeoutMs ?? IMAGE_ENCODE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sniffFormat(bytes: Uint8Array): AllowedFormat | undefined {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((value, index) => bytes[offset + index] === value);
  if (startsWith([0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    return bytes[5] === 0x61 ? "gif" : undefined;
  }
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8))
    return "webp";
  return undefined;
}

function toImageError(error: unknown): LinkPreviewError {
  if (error instanceof LinkPreviewError) return error;
  // sharp words its refusal "Input image exceeds pixel limit"; any other decode failure is a bad image.
  const tooLarge = error instanceof Error && /pixel limit/i.test(error.message);
  return new LinkPreviewError(tooLarge ? "too_large" : "unsupported_type");
}
