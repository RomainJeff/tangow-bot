import type { MessageBlock } from "@rakazo/contracts";
import { sizes } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import {
  blocksWithoutPreviewedLinkLine,
  cardReplacesBubble,
  composerThumbnailFit,
  linkCardWidth,
  linkPreviewCardOf,
  linkPreviewImageFit,
  linkPreviewImageHeight,
  linkPreviewLabel,
  openableLinkPreviewUrl,
} from "./link-preview";

const image = { artifactId: "art_1", width: 1200, height: 630 };
const compact = {
  kind: "link_preview",
  url: "https://www.example.com/post",
  format: "compact",
  title: "A post",
} as MessageBlock;
const large = { ...compact, format: "large", image } as MessageBlock;
const photo = {
  kind: "link_preview",
  url: "https://img.example.com/p.webp",
  format: "photo",
  image: { artifactId: "art_2", width: 800, height: 2000 },
} as MessageBlock;
const text = (value: string) => ({ kind: "text", text: value }) as MessageBlock;
const unchecked = (block: object) => block as MessageBlock;
const cardOf = (blocks: MessageBlock[], role = "bot") => linkPreviewCardOf({ role, blocks });

describe("linkPreviewCardOf", () => {
  it("returns the card for each of the three formats", () => {
    for (const block of [compact, large, photo]) {
      expect(cardOf([text("hi"), block])).toEqual(block);
    }
  });

  it("renders nothing for a message without a card", () => {
    expect(cardOf([text("hi")])).toBeUndefined();
    expect(cardOf([])).toBeUndefined();
  });

  it("renders nothing for a removal marker, and the marker wins over a card", () => {
    const marker = unchecked({ kind: "link_preview", url: "https://a.tld/x", removed: true });
    expect(cardOf([text("hi"), marker])).toBeUndefined();
    expect(cardOf([compact, marker])).toBeUndefined();
  });

  it("draws no card on a message that is itself a card, nor on a system message", () => {
    for (const host of [
      { kind: "ask", text: "Which?", status: "answered" },
      { kind: "routine_run", routineId: "r" },
      { kind: "handoff" },
      { kind: "mcp_approval" },
      { kind: "choice", text: "Pick" },
    ]) {
      expect(cardOf([text("hi"), unchecked(host), compact])).toBeUndefined();
    }
    expect(cardOf([text("hi"), compact], "system")).toBeUndefined();
    expect(cardOf([text("hi"), unchecked({ kind: "choice", answerId: "a" }), compact])).toEqual(
      compact,
    );
  });

  it("cleans the stored title again, as web does", () => {
    const dirty = unchecked({ ...compact, title: "  A\u202Epost\u200B\n here  " });
    expect(cardOf([dirty])).toMatchObject({ title: "Apost here" });
    expect(cardOf([unchecked({ ...compact, title: "\u200B\u202E " })])).toBeUndefined();
  });

  it("drops a url that is not http(s), whatever the scheme", () => {
    for (const url of [
      "javascript:alert(1)",
      "itms-services://?action=download-manifest&url=https://a.tld/m.plist",
      "tel:+33123456789",
      "mailto:a@b.tld",
      "file:///etc/passwd",
      "https://user:pass@a.tld/x",
    ]) {
      expect(cardOf([unchecked({ ...compact, url })])).toBeUndefined();
    }
  });

  it("drops a block that lacks what its format draws", () => {
    expect(cardOf([unchecked({ ...compact, format: "large" })])).toBeUndefined();
    expect(cardOf([unchecked({ ...photo, image: undefined })])).toBeUndefined();
    expect(cardOf([unchecked({ ...compact, title: undefined })])).toBeUndefined();
  });
});

describe("openableLinkPreviewUrl", () => {
  it("opens http and https only", () => {
    expect(openableLinkPreviewUrl("https://a.tld/x")).toBe("https://a.tld/x");
    expect(openableLinkPreviewUrl("http://a.tld/x")).toBe("http://a.tld/x");
    expect(openableLinkPreviewUrl("tel:+33123456789")).toBeUndefined();
    expect(openableLinkPreviewUrl("mailto:a@b.tld")).toBeUndefined();
    expect(openableLinkPreviewUrl("itms-services://?action=download-manifest")).toBeUndefined();
    expect(openableLinkPreviewUrl("not a url")).toBeUndefined();
  });
});

describe("cardReplacesBubble", () => {
  const card = cardOf([compact])!;
  it("takes the bubble's place when the message is only the link", () => {
    expect(cardReplacesBubble([text("https://www.example.com/post"), compact], card)).toBe(true);
    expect(cardReplacesBubble([text("  <https://www.example.com/post>\n"), compact], card)).toBe(
      true,
    );
    expect(
      cardReplacesBubble(
        [text("[https://www.example.com/post](https://www.example.com/post)"), compact],
        card,
      ),
    ).toBe(true);
  });

  it("keeps the bubble, and its steps, when the row shows steps", () => {
    const steps = unchecked({ kind: "steps", steps: [] });
    expect(cardReplacesBubble([steps, text("https://www.example.com/post"), compact], card)).toBe(
      false,
    );
    const reasoning = unchecked({ kind: "reasoning", text: "thinking" });
    expect(
      cardReplacesBubble([reasoning, text("https://www.example.com/post"), compact], card),
    ).toBe(true);
  });

  it("still takes the bubble's place when the reply also carries skill lines", () => {
    const skill = unchecked({
      kind: "skill_source",
      skillUid: "0123456789abcdef0123456789abcdef",
      skillId: "user:coffee",
      name: "Coffee",
      change: "learned",
    });
    expect(cardReplacesBubble([text("https://www.example.com/post"), compact, skill], card)).toBe(
      true,
    );
  });

  it("keeps the bubble when a word is added or other content is attached", () => {
    expect(cardReplacesBubble([text("look https://www.example.com/post"), compact], card)).toBe(
      false,
    );
    const file = unchecked({ kind: "file", name: "a.pdf", artifactId: "art_3" });
    expect(cardReplacesBubble([text("https://www.example.com/post"), file, compact], card)).toBe(
      false,
    );
  });
});

describe("linkPreviewLabel", () => {
  it("names the title and the full host, without www", () => {
    expect(linkPreviewLabel(cardOf([compact])!)).toBe("A post, example.com");
    expect(linkPreviewLabel(cardOf([photo])!)).toBe("img.example.com");
  });

  it("keeps a lookalike host whole", () => {
    const host = "accounts.google.com.evil.tld.example";
    const card = cardOf([unchecked({ ...compact, url: `https://${host}/` })])!;
    expect(linkPreviewLabel(card)).toBe(`A post, ${host}`);
  });
});

describe("linkCardWidth", () => {
  const base = { windowWidth: 402, gutter: 14, avatarColumn: 34 };
  it("caps a single-bot card at 82% of the thread, as a whole number", () => {
    expect(linkCardWidth({ ...base, mono: true })).toBe(Math.floor((402 - 28) * 0.82));
  });

  it("caps a group card at 88% of the column right of the avatar", () => {
    expect(linkCardWidth({ ...base, mono: false })).toBe(Math.floor((402 - 28 - 34) * 0.88));
  });

  it("caps the person's own card like their bubble, at 78% of the thread", () => {
    expect(linkCardWidth({ ...base, mono: true, byPerson: true })).toBe(
      Math.floor((402 - 28) * 0.78),
    );
  });

  it("never grows past the link card token, on a wide window", () => {
    expect(linkCardWidth({ ...base, windowWidth: 1024, mono: true })).toBe(sizes.linkCard);
  });

  it("never goes negative", () => {
    expect(linkCardWidth({ ...base, windowWidth: 10, mono: false })).toBe(0);
  });
});

describe("linkPreviewImageHeight", () => {
  it("draws the large image at 1.91:1", () => {
    expect(linkPreviewImageHeight(cardOf([large])!, 300)).toBe(157);
  });

  it("draws a photo at its own proportions, capped", () => {
    expect(linkPreviewImageHeight(cardOf([photo])!, 300)).toBe(sizes.linkPhotoMax);
    const wide = unchecked({ ...photo, image: { artifactId: "art_2", width: 800, height: 400 } });
    expect(linkPreviewImageHeight(cardOf([wide])!, 300)).toBe(150);
  });

  it("has no image height for compact, which draws a fixed thumbnail", () => {
    expect(linkPreviewImageHeight(cardOf([compact])!, 300)).toBeUndefined();
  });
});

describe("linkPreviewImageFit", () => {
  const icon = unchecked({ ...compact, image: { ...image, fit: "contain" } });

  it("draws a site icon whole, with an inset", () => {
    expect(linkPreviewImageFit(cardOf([icon])!)).toEqual({
      resizeMode: "contain",
      inset: sizes.linkIconInset,
    });
    expect(composerThumbnailFit("contain")).toEqual({
      resizeMode: "contain",
      inset: sizes.linkIconInset,
    });
  });

  it("crops every other picture, and an icon marker on another format", () => {
    const thumbnail = unchecked({ ...compact, image });
    expect(linkPreviewImageFit(cardOf([thumbnail])!)).toEqual({ resizeMode: "cover", inset: 0 });
    expect(linkPreviewImageFit(cardOf([large])!)).toEqual({ resizeMode: "cover", inset: 0 });
    const largeIcon = unchecked({ ...large, image: { ...image, fit: "contain" } });
    expect(linkPreviewImageFit(cardOf([largeIcon])!)).toEqual({ resizeMode: "cover", inset: 0 });
    expect(composerThumbnailFit(undefined)).toEqual({ resizeMode: "cover", inset: 0 });
  });
});

describe("blocksWithoutPreviewedLinkLine", () => {
  const url = "https://www.example.com/post";

  it("leaves the link line out of each text and keeps the rest (CA 78)", () => {
    const steps = unchecked({ kind: "steps", steps: [] });
    expect(blocksWithoutPreviewedLinkLine([text(`Voici :\n${url}`), steps, compact], url)).toEqual([
      text("Voici :"),
      steps,
      compact,
    ]);
    expect(blocksWithoutPreviewedLinkLine([text(`<${url}>\n\nSuite`)], url)).toEqual([
      text("Suite"),
    ]);
  });

  it("drops a text that was nothing but the link", () => {
    expect(blocksWithoutPreviewedLinkLine([text(url), compact], url)).toEqual([compact]);
  });

  it("keeps a link inside a sentence and returns unchanged blocks as they are", () => {
    const blocks = [text(`Regarde ${url} c'est bien`), compact];
    expect(blocksWithoutPreviewedLinkLine(blocks, url)).toEqual(blocks);
    expect(blocksWithoutPreviewedLinkLine(blocks, url)[0]).toBe(blocks[0]);
  });

  it("never changes the stored message", () => {
    const blocks = [text(`Voici :\n${url}`)];
    blocksWithoutPreviewedLinkLine(blocks, url);
    expect(blocks).toEqual([text(`Voici :\n${url}`)]);
  });
});
