import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { LinkPreviewError, type LinkPreviewFailureReason } from "./errors.js";
import {
  createThumbnailDataUrl,
  encodePreviewImage,
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_THUMBNAIL_DATA_URL_LENGTH,
} from "./image.js";
import { createSemaphore, type Semaphore } from "./limits.js";

const solid = (width: number, height: number, background = "#3366cc") =>
  sharp({ create: { width, height, channels: 3, background } });

async function reasonOf(promise: Promise<unknown>): Promise<LinkPreviewFailureReason | "resolved"> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    expect(error).toBeInstanceOf(LinkPreviewError);
    return (error as LinkPreviewError).reason;
  }
}

/** A PNG whose header claims a size; the pixels are never provided. The decoder must refuse
 * it from the header alone, so the test costs a few hundred bytes whatever the claim. */
function pngClaiming(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc(1))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function animated(format: "gif" | "webp", frames: number): Promise<Buffer> {
  const size = 16;
  const raw = Buffer.alloc(size * size * 3 * frames);
  for (let frame = 0; frame < frames; frame += 1) {
    // Frame 0 is red, every later frame differs from its neighbours and is blue-ish: the
    // output must show red (identical frames would be merged by the encoder).
    const color = frame === 0 ? [255, 0, 0] : [0, (frame * 7) % 256, 255];
    for (let pixel = 0; pixel < size * size; pixel += 1) {
      raw.set(color, (frame * size * size + pixel) * 3);
    }
  }
  const image = sharp(raw, {
    raw: { width: size, height: size * frames, channels: 3, pageHeight: size },
  });
  return format === "gif"
    ? image.gif({ delay: Array(frames).fill(40), loop: 0 }).toBuffer()
    : image.webp({ delay: Array(frames).fill(40), loop: 0 }).toBuffer();
}

describe("encodePreviewImage", () => {
  it.each([
    ["jpeg", () => solid(300, 200).jpeg().toBuffer()],
    ["png", () => solid(300, 200).png().toBuffer()],
    ["webp", () => solid(300, 200).webp().toBuffer()],
    ["gif", () => solid(300, 200).gif().toBuffer()],
  ] as const)("re-encodes %s to WebP at its own size", async (_format, make) => {
    const result = await encodePreviewImage(await make());
    expect(result).toMatchObject({ width: 300, height: 200 });
    const meta = await sharp(result.bytes).metadata();
    expect(meta).toMatchObject({ format: "webp", width: 300, height: 200 });
  });

  it("scales down to 1200 px wide and never enlarges", async () => {
    const big = await encodePreviewImage(await solid(2400, 1200).png().toBuffer());
    expect(big).toMatchObject({ width: 1200, height: 600 });
    expect((await sharp(big.bytes).metadata()).width).toBe(1200);
    const small = await encodePreviewImage(await solid(64, 32).png().toBuffer());
    expect(small).toMatchObject({ width: 64, height: 32 });
  });

  it("applies the EXIF orientation, then drops every EXIF field", async () => {
    const jpeg = await solid(100, 50)
      .jpeg()
      .withExif({ IFD0: { Copyright: "secret-owner", Artist: "secret-gps-person" } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();

    const result = await encodePreviewImage(jpeg);
    expect(result).toMatchObject({ width: 50, height: 100 });
    const meta = await sharp(result.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(result.bytes.includes(Buffer.from("secret-owner"))).toBe(false);
  });

  it.each(["gif", "webp"] as const)("keeps the first frame of an animated %s", async (format) => {
    const source = await animated(format, 300);
    expect((await sharp(source, { pages: -1 }).metadata()).pages).toBeGreaterThan(50);
    const result = await encodePreviewImage(source);
    expect(result).toMatchObject({ width: 16, height: 16 });
    const meta = await sharp(result.bytes, { pages: -1 }).metadata();
    expect(meta.pages ?? 1).toBe(1);
    const { data } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[2]).toBeLessThan(60);
  });

  it("refuses images over 25 megapixels without decoding them", async () => {
    const before = process.memoryUsage().rss;
    expect(await reasonOf(encodePreviewImage(pngClaiming(40_000, 40_000)))).toBe("too_large");
    expect(await reasonOf(encodePreviewImage(pngClaiming(5_100, 5_000)))).toBe("too_large");
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
  });

  it("accepts an image just under the pixel limit header-wise", async () => {
    // 4,900 x 5,000 = 24.5 Mpx passes the limit; the missing pixel data then fails the decode.
    expect(await reasonOf(encodePreviewImage(pngClaiming(4_900, 5_000)))).toBe("unsupported_type");
  });

  it.each([
    [
      "SVG",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>1</script></svg>',
      ),
    ],
    [
      "SVG with prolog",
      Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ],
    ["AVIF", Buffer.from("0000001c667479706176696600000000617669666d696631", "hex")],
    ["HEIC", Buffer.from("0000001c6674797068656963000000006d696631", "hex")],
    ["BMP", Buffer.from("424d3600000000000000360000002800", "hex")],
    ["TIFF", Buffer.from("49492a000800000000", "hex")],
    ["PDF", Buffer.from("%PDF-1.4\n")],
    ["HTML", Buffer.from("<html><body>hello</body></html>")],
    ["empty", Buffer.alloc(0)],
    ["text", Buffer.from("hello world")],
    ["RIFF but not WebP", Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ")],
  ] as const)("refuses %s", async (_name, bytes) => {
    expect(await reasonOf(encodePreviewImage(bytes))).toBe("unsupported_type");
  });

  it("refuses polyglots that only start like a whitelisted image", async () => {
    expect(
      await reasonOf(encodePreviewImage(Buffer.from("GIF89a/*\u0000\u0000*/=1;alert(1)//"))),
    ).toBe("unsupported_type");
    expect(await reasonOf(encodePreviewImage(Buffer.from("GIF8", "latin1")))).toBe(
      "unsupported_type",
    );
    expect(
      await reasonOf(
        encodePreviewImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(64)])),
      ),
    ).toBe("unsupported_type");
  });

  it("drops what is appended after a valid JPEG (JPEG + ZIP)", async () => {
    const jpeg = await solid(40, 30).jpeg().toBuffer();
    const zip = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("payload-in-zip")]);
    const result = await encodePreviewImage(Buffer.concat([jpeg, zip]));
    expect(result).toMatchObject({ width: 40, height: 30 });
    expect(result.bytes.includes(Buffer.from("payload-in-zip"))).toBe(false);
  });

  it("refuses an output over 400 KiB", async () => {
    const noise = await sharp(randomBytes(1200 * 1200 * 3), {
      raw: { width: 1200, height: 1200, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(await reasonOf(encodePreviewImage(noise))).toBe("too_large");
    expect(MAX_PREVIEW_IMAGE_BYTES).toBe(400 * 1024);
  });

  it("gives up at its own timeout but keeps the slot until the work ends", async () => {
    const semaphore = createSemaphore(1);
    let workEnded = false;
    const watched: Semaphore = {
      run: (work) =>
        semaphore.run(async () => {
          try {
            return await work();
          } finally {
            workEnded = true;
          }
        }),
    };
    const noise = await sharp(randomBytes(1500 * 1500 * 3), {
      raw: { width: 1500, height: 1500, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(await reasonOf(encodePreviewImage(noise, { timeoutMs: 1, semaphore: watched }))).toBe(
      "timeout",
    );
    expect(workEnded).toBe(false);
    expect(await semaphore.run(async () => workEnded)).toBe(true);
  });

  it("times out when no slot ever frees up", async () => {
    const stuck: Semaphore = { run: () => new Promise(() => undefined) };
    const png = await solid(10, 10).png().toBuffer();
    expect(await reasonOf(encodePreviewImage(png, { timeoutMs: 40, semaphore: stuck }))).toBe(
      "timeout",
    );
  });
});

describe("createThumbnailDataUrl", () => {
  const decode = (url: string) =>
    Buffer.from(url.slice("data:image/webp;base64,".length), "base64");

  it("returns a small WebP data URL", async () => {
    const { bytes } = await encodePreviewImage(await solid(1200, 800).png().toBuffer());
    const url = await createThumbnailDataUrl(bytes);
    expect(url.startsWith("data:image/webp;base64,")).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAX_THUMBNAIL_DATA_URL_LENGTH);
    const meta = await sharp(decode(url)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBeLessThanOrEqual(320);
  });

  it("keeps a noisy image within 50 KiB", async () => {
    const noise = await sharp(randomBytes(800 * 600 * 3), {
      raw: { width: 800, height: 600, channels: 3 },
    })
      .webp({ quality: 90 })
      .toBuffer();
    const url = await createThumbnailDataUrl(noise);
    expect(url.length).toBeLessThanOrEqual(MAX_THUMBNAIL_DATA_URL_LENGTH);
  });
});
