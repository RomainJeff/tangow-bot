import { describe, expect, it } from "vitest";
import {
  appContract,
  isLinkPreviewCard,
  LINK_PREVIEW_URL_MAX_LENGTH,
  LinkPreviewDraftSchema,
  MessageBlock,
  MessageBlocks,
  parseKnownMessageBlocks,
} from "./index.js";

const image = { artifactId: "art-1", width: 1200, height: 630 };

describe("link_preview block", () => {
  it("accepts the three preview formats", () => {
    const large = {
      kind: "link_preview",
      url: "https://a.tld/x",
      format: "large",
      title: "T",
      image,
    };
    const photo = { kind: "link_preview", url: "https://a.tld/p.png", format: "photo", image };
    const compact = { kind: "link_preview", url: "http://a.tld/x", format: "compact", title: "T" };
    for (const block of [large, photo, compact]) {
      expect(MessageBlock.parse(block)).toEqual(block);
    }
  });

  it("requires an image for large and photo, and a title for large and compact", () => {
    const base = { kind: "link_preview", url: "https://a.tld/x" };
    expect(MessageBlock.safeParse({ ...base, format: "large", title: "T" }).success).toBe(false);
    expect(MessageBlock.safeParse({ ...base, format: "photo" }).success).toBe(false);
    expect(MessageBlock.safeParse({ ...base, format: "large", image }).success).toBe(false);
    expect(MessageBlock.safeParse({ ...base, format: "compact" }).success).toBe(false);
    expect(MessageBlock.safeParse({ ...base, format: "compact", title: "T" }).success).toBe(true);
  });

  it("needs a url and a format unless it is a removal marker", () => {
    expect(
      MessageBlock.safeParse({ kind: "link_preview", format: "compact", title: "T" }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({ kind: "link_preview", url: "https://a.tld/x", title: "T" }).success,
    ).toBe(false);
    expect(MessageBlock.safeParse({ kind: "link_preview" }).success).toBe(false);
    expect(
      MessageBlock.safeParse({ kind: "link_preview", removed: true, format: "compact", title: "T" })
        .success,
    ).toBe(false);
  });

  it("narrows a card from a removal marker", () => {
    const card = MessageBlock.parse({
      kind: "link_preview",
      url: "https://a.tld/x",
      format: "compact",
      title: "T",
    });
    const marker = MessageBlock.parse({ kind: "link_preview", removed: true });
    expect(card.kind === "link_preview" && isLinkPreviewCard(card)).toBe(true);
    expect(marker.kind === "link_preview" && isLinkPreviewCard(marker)).toBe(false);
  });

  it("caps the title, the url length and the image dimensions", () => {
    const base = { kind: "link_preview", url: "https://a.tld/x", format: "compact" };
    expect(MessageBlock.safeParse({ ...base, title: "x".repeat(300) }).success).toBe(true);
    expect(MessageBlock.safeParse({ ...base, title: "x".repeat(301) }).success).toBe(false);
    const pad = "a".repeat(LINK_PREVIEW_URL_MAX_LENGTH - "https://a.tld/".length);
    expect(
      MessageBlock.safeParse({ ...base, title: "T", url: `https://a.tld/${pad}` }).success,
    ).toBe(true);
    expect(
      MessageBlock.safeParse({ ...base, title: "T", url: `https://a.tld/${pad}a` }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "link_preview",
        url: "https://a.tld/x",
        format: "photo",
        image: { ...image, width: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects credentials in the url", () => {
    const base = { kind: "link_preview", format: "compact", title: "T" };
    expect(MessageBlock.safeParse({ ...base, url: "https://user:pw@a.tld/x" }).success).toBe(false);
    expect(MessageBlock.safeParse({ ...base, url: "https://user@a.tld/x" }).success).toBe(false);
  });

  it("accepts a removal marker with or without a url, and never a bad url", () => {
    expect(MessageBlock.parse({ kind: "link_preview", removed: true })).toEqual({
      kind: "link_preview",
      removed: true,
    });
    expect(
      MessageBlock.parse({ kind: "link_preview", removed: true, url: "https://a.tld/x" }),
    ).toEqual({
      kind: "link_preview",
      removed: true,
      url: "https://a.tld/x",
    });
    expect(
      MessageBlock.safeParse({ kind: "link_preview", removed: true, url: "javascript:alert(1)" })
        .success,
    ).toBe(false);
    expect(MessageBlock.safeParse({ kind: "link_preview", removed: false }).success).toBe(false);
  });

  it("has no text or site field to leak into model history or to disagree with the url", () => {
    const parsed = MessageBlock.parse({
      kind: "link_preview",
      url: "https://a.tld/x",
      format: "compact",
      title: "T",
      text: "leak",
      site: "evil.tld",
    });
    expect(parsed).not.toHaveProperty("text");
    expect(parsed).not.toHaveProperty("site");
  });

  it("drops blocks whose url is not http(s) through the tolerant parse", () => {
    const good = { kind: "link_preview", url: "https://a.tld/x", format: "compact", title: "T" };
    const stored = [
      { kind: "text", text: "hi" },
      ...[
        "javascript:alert(1)",
        "itms-services://?action=download-manifest&url=https://a.tld/m.plist",
        "mailto:a@b.tld",
        "tel:+33123456789",
        "file:///etc/passwd",
        "//a.tld/x",
      ].map((url) => ({ ...good, url })),
      { kind: "link_preview", removed: true, url: "mailto:a@b.tld" },
      good,
    ];
    expect(MessageBlocks.parse(stored)).toEqual([{ kind: "text", text: "hi" }, good]);
    expect(parseKnownMessageBlocks(stored).map(({ index }) => index)).toEqual([
      0,
      stored.length - 1,
    ]);
  });
});

describe("link preview rpc contracts", () => {
  it("accepts linkPreview: false on send and followUp, nothing else", () => {
    const send = appContract.threads.send["~orpc"].inputSchema!;
    const followUp = appContract.threads.followUp["~orpc"].inputSchema!;
    expect(
      send["~standard"].validate({ botId: "b", text: "hi", linkPreview: false }),
    ).not.toHaveProperty("issues");
    expect(
      followUp["~standard"].validate({ botId: "b", text: "hi", linkPreview: false }),
    ).not.toHaveProperty("issues");
    expect(
      send["~standard"].validate({ botId: "b", text: "hi", linkPreview: true }),
    ).toHaveProperty("issues");
    expect(
      followUp["~standard"].validate({ botId: "b", text: "hi", linkPreview: true }),
    ).toHaveProperty("issues");
  });

  it("bounds the links.preview input and removeLinkPreview takes a message id", () => {
    const input = appContract.links.preview["~orpc"].inputSchema!;
    expect(input["~standard"].validate({ threadId: "t", url: "https://a.tld" })).not.toHaveProperty(
      "issues",
    );
    expect(
      input["~standard"].validate({
        threadId: "t",
        url: "h".repeat(LINK_PREVIEW_URL_MAX_LENGTH + 1),
      }),
    ).toHaveProperty("issues");
    const remove = appContract.messages.removeLinkPreview["~orpc"].inputSchema!;
    expect(remove["~standard"].validate({ messageId: "m" })).not.toHaveProperty("issues");
    expect(remove["~standard"].validate({})).toHaveProperty("issues");
  });

  it("only lets a draft carry an inline WebP thumbnail of bounded size", () => {
    const thumbnail = "data:image/webp;base64,AAAA";
    expect(LinkPreviewDraftSchema.parse({ format: "compact", title: "T", thumbnail })).toEqual({
      format: "compact",
      title: "T",
      thumbnail,
    });
    expect(
      LinkPreviewDraftSchema.safeParse({ format: "compact", thumbnail: "https://a.tld/i.png" })
        .success,
    ).toBe(false);
    expect(
      LinkPreviewDraftSchema.safeParse({
        format: "compact",
        thumbnail: "data:image/svg+xml;base64,AAAA",
      }).success,
    ).toBe(false);
    expect(
      LinkPreviewDraftSchema.safeParse({
        format: "compact",
        thumbnail: `data:image/webp;base64,${"A".repeat(70_000)}`,
      }).success,
    ).toBe(false);
  });
});
