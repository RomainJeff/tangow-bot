import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { blocksToAgentHistoryText } from "./attachments.js";
import {
  hasSecretParam,
  isAuthenticationDestination,
  isEligibleLink,
  isLinkOnlyMessage,
  linkKey,
  linkMentionCandidates,
  linkMentionLabel,
  linkMentionsKey,
  linkMentionsOf,
  messageHostsLinkPreview,
  normalizePreviewUrl,
  previewSiteInitial,
  previewSiteLabel,
  previewTitleFromUrl,
  sanitizePreviewTitle,
  textWithoutPreviewedLinkLine,
} from "./link-preview.js";
import { isNarrationMessage, isUserNarrationMessage } from "./message-grouping.js";
import { isAsideOnlyMessage } from "./message-visibility.js";
import { speechFromBlocks } from "./speech-text.js";

const firstCandidate = (text: string) => linkMentionCandidates(text)[0]?.url;

describe("the first link candidate", () => {
  it("takes the first http(s) link and ignores the others", () => {
    expect(firstCandidate("a https://a.tld/1 b https://b.tld/2")).toBe("https://a.tld/1");
    expect(firstCandidate("no link here")).toBeUndefined();
    expect(firstCandidate("ftp://a.tld/x javascript:alert(1) mailto:a@b.tld")).toBeUndefined();
  });

  it("takes a bare www. address as the https link it stands for", () => {
    expect(firstCandidate("www.lemonde.fr ")).toBe("https://www.lemonde.fr");
    expect(firstCandidate("voir www.lemonde.fr/x, merci")).toBe("https://www.lemonde.fr/x");
    expect(firstCandidate("(see www.lemonde.fr/x).")).toBe("https://www.lemonde.fr/x");
    expect(firstCandidate("`www.lemonde.fr`")).toBeUndefined();
    expect(firstCandidate("```\nwww.lemonde.fr\n```")).toBeUndefined();
    expect(firstCandidate("lemonde.fr")).toBeUndefined();
    expect(firstCandidate("README.md www.lemonde")).toBeUndefined();
    expect(firstCandidate("awww.lemonde.fr")).toBeUndefined();
    expect(firstCandidate("www.lemonde.fr then https://a.tld")).toBe("https://www.lemonde.fr");
  });

  it("skips fenced and inline code", () => {
    expect(firstCandidate("```\nhttps://code.tld/1\n```\nhttps://real.tld/2")).toBe(
      "https://real.tld/2",
    );
    expect(firstCandidate("```js\nfetch('https://code.tld/1')\n```")).toBeUndefined();
    expect(firstCandidate("~~~\nhttps://code.tld/1\n~~~\n")).toBeUndefined();
    expect(firstCandidate("an unterminated fence\n```\nhttps://code.tld/1")).toBeUndefined();
    expect(firstCandidate("run `curl https://code.tld/1` then https://real.tld/2")).toBe(
      "https://real.tld/2",
    );
    expect(firstCandidate("``a ` https://code.tld/1 ``")).toBeUndefined();
    expect(firstCandidate("an unclosed ` tick https://real.tld/2")).toBe("https://real.tld/2");
    expect(firstCandidate("```inline https://code.tld/1``` then https://real.tld/2")).toBe(
      "https://real.tld/2",
    );
    // A longer fence is not closed by a shorter one.
    expect(firstCandidate("````\n```\nhttps://code.tld/1\n```\n````\nend")).toBeUndefined();
  });

  it("counts a markdown link by its destination", () => {
    expect(firstCandidate("[the docs](https://a.tld/docs) and https://b.tld")).toBe(
      "https://a.tld/docs",
    );
    expect(firstCandidate("[https://label.tld](https://target.tld/x)")).toBe(
      "https://target.tld/x",
    );
    expect(firstCandidate("[a](https://a.tld/p)text")).toBe("https://a.tld/p");
    expect(firstCandidate("[a](https://a.tld/Foo_(bar))")).toBe("https://a.tld/Foo_(bar)");
    expect(firstCandidate('[a](https://a.tld/x "title")')).toBe("https://a.tld/x");
    expect(firstCandidate("[a](/relative) then https://b.tld")).toBe("https://b.tld");
    expect(firstCandidate("[`code`](https://a.tld/x)")).toBe("https://a.tld/x");
    expect(firstCandidate("<https://a.tld/x>")).toBe("https://a.tld/x");
  });

  it("keeps balanced parentheses and apostrophes, trims trailing punctuation", () => {
    expect(firstCandidate("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
    expect(firstCandidate("(see https://a.tld/docs).")).toBe("https://a.tld/docs");
    expect(firstCandidate("(see https://a.tld/Foo_(bar)).")).toBe("https://a.tld/Foo_(bar)");
    expect(firstCandidate("https://a.tld/it's-a-page")).toBe("https://a.tld/it's-a-page");
    expect(firstCandidate("'https://a.tld/x'")).toBe("https://a.tld/x");
    expect(firstCandidate('"https://a.tld/x",')).toBe("https://a.tld/x");
    expect(firstCandidate("so https://a.tld/x?a=1&b=2, or https://b.tld!")).toBe(
      "https://a.tld/x?a=1&b=2",
    );
    expect(firstCandidate("[https://a.tld/x]")).toBe("https://a.tld/x");
    expect(firstCandidate("*https://a.tld/x*")).toBe("https://a.tld/x");
  });

  it("rejects credentials and over-long urls, and moves on to the next link", () => {
    expect(firstCandidate("https://user:pw@a.tld/x")).toBeUndefined();
    expect(firstCandidate("https://user@a.tld/x https://b.tld/y")).toBe("https://b.tld/y");
    const long = `https://a.tld/${"a".repeat(2048)}`;
    expect(firstCandidate(long)).toBeUndefined();
    expect(firstCandidate(`${long} https://b.tld/y`)).toBe("https://b.tld/y");
    const exact = `https://a.tld/${"a".repeat(2048 - "https://a.tld/".length)}`;
    expect(firstCandidate(exact)).toBe(exact);
  });
});

describe("linkMentionCandidates (CA 6, 16, 20, 21)", () => {
  const urls = (text: string) => linkMentionCandidates(text).map((link) => link.url);

  it("keeps the first five distinct keys in text order", () => {
    const seven = Array.from({ length: 7 }, (_, i) => `https://s${i}.test/p`).join(" and ");
    expect(urls(seven)).toEqual([
      "https://s0.test/p",
      "https://s1.test/p",
      "https://s2.test/p",
      "https://s3.test/p",
      "https://s4.test/p",
    ]);
  });

  it("filters every link before counting, so a token or sign-in link takes no slot", () => {
    const text =
      "https://a.test/x?token=abc https://accounts.google.com/signin " +
      "https://b.test/1 https://c.test/2 https://d.test/3 https://e.test/4 https://f.test/5";
    expect(urls(text)).toEqual([
      "https://b.test/1",
      "https://c.test/2",
      "https://d.test/3",
      "https://e.test/4",
      "https://f.test/5",
    ]);
  });

  it("gives one candidate per key: a bare www. form, fragments, and a link said twice", () => {
    expect(linkMentionCandidates("www.x.test/a then https://www.x.test/a")).toEqual([
      { key: "https://www.x.test/a", url: "https://www.x.test/a" },
    ]);
    expect(linkMentionCandidates("https://x.test/a#b and https://x.test/a#c")).toEqual([
      { key: "https://x.test/a", url: "https://x.test/a#b" },
    ]);
    expect(urls("- https://x.test/doc\n\nas said, [the doc](https://x.test/doc).")).toEqual([
      "https://x.test/doc",
    ]);
  });

  it("never takes a link in code", () => {
    expect(urls("`https://a.test/x` and https://b.test/y")).toEqual(["https://b.test/y"]);
  });
});

describe("linkKey", () => {
  it("is the normalized https form, without fragment", () => {
    expect(linkKey("www.X.test/a#top")).toBe("https://www.x.test/a");
    expect(linkKey("https://x.test:443/a?b=1#c")).toBe("https://x.test/a?b=1");
    expect(linkKey("ftp://x.test/a")).toBeNull();
    expect(linkKey("not a link")).toBeNull();
  });
});

describe("isEligibleLink (CA 20, 21)", () => {
  it("refuses whole one-shot path segments, decoded and in any case", () => {
    for (const url of [
      "https://a.test/unsubscribe/x",
      "https://a.test/a/confirm/x",
      "https://a.test/Reset/x",
      "https://a.test/invite/x",
      "https://a.test/%69nvite/x",
      "https://slack.test/shared_invite/zt-1",
      "https://a.test/opt-out",
    ]) {
      expect([url, isEligibleLink(url)]).toEqual([url, false]);
    }
  });

  it("still reads a path that only contains such a word, and ordinary documents", () => {
    for (const url of [
      "https://a.test/blog/how-to-reset-password",
      "https://docs.test/document/d/1AbC/edit",
      "https://a.test/invited-talks",
    ]) {
      expect([url, isEligibleLink(url)]).toEqual([url, true]);
    }
  });

  it("refuses a secret query, a sign-in page, another scheme and a link over 2 048 characters", () => {
    expect(isEligibleLink("https://a.test/x?access_token=1")).toBe(false);
    expect(isEligibleLink("https://accounts.google.com/signin")).toBe(false);
    expect(isEligibleLink("ftp://a.test/x")).toBe(false);
    expect(isEligibleLink(`https://a.test/${"a".repeat(2048)}`)).toBe(false);
    expect(isEligibleLink("https://a.test/x?page=2")).toBe(true);
  });
});

describe("isLinkOnlyMessage", () => {
  const url = "https://a.tld/x";
  it("accepts the bare url, in angle brackets, or a markdown link labelled with it", () => {
    expect(isLinkOnlyMessage(url, url)).toBe(true);
    expect(isLinkOnlyMessage(`  \n${url}\n `, url)).toBe(true);
    expect(isLinkOnlyMessage(`<${url}>`, url)).toBe(true);
    expect(isLinkOnlyMessage(`[${url}](${url})`, url)).toBe(true);
  });

  it("accepts a bare www. address for the https link it stands for", () => {
    expect(isLinkOnlyMessage("www.lemonde.fr", "https://www.lemonde.fr")).toBe(true);
    expect(isLinkOnlyMessage(" <www.lemonde.fr/x>\n", "https://www.lemonde.fr/x")).toBe(true);
    expect(isLinkOnlyMessage("www.lemonde.fr.", "https://www.lemonde.fr")).toBe(false);
    expect(isLinkOnlyMessage("www.lemonde.fr", "https://www.lemonde.fr/x")).toBe(false);
    expect(isLinkOnlyMessage("lemonde.fr", "https://lemonde.fr")).toBe(false);
  });

  it("rejects anything more than the link", () => {
    expect(isLinkOnlyMessage(`look ${url}`, url)).toBe(false);
    expect(isLinkOnlyMessage(`${url} please`, url)).toBe(false);
    expect(isLinkOnlyMessage(`${url}.`, url)).toBe(false);
    expect(isLinkOnlyMessage(`[label](${url})`, url)).toBe(false);
    expect(isLinkOnlyMessage(`${url}\nhttps://b.tld`, url)).toBe(false);
    expect(isLinkOnlyMessage(`${url}/`, url)).toBe(false);
  });
});

describe("previewSiteInitial (CA 77)", () => {
  it.each([
    ["https://www.lefigaro.fr/vie-de-bureau/x", "L"],
    ["https://example.com/", "E"],
    ["https://Blog.Example.com:8443/a", "B"],
    ["https://www.www.example.com/", "W"],
    ["https://bücher.de/", "X"],
    ["https://éclair.fr/", "X"],
    ["http://192.168.1.1/", "1"],
  ])("%s shows %s", (url, initial) => {
    expect(previewSiteInitial(url)).toBe(initial);
  });

  it("is empty for text that is no url", () => {
    expect(previewSiteInitial("nonsense")).toBe("");
  });
});

describe("textWithoutPreviewedLinkLine (CA 78, 79)", () => {
  const url = "https://www.lefigaro.fr/vie-de-bureau/article-12";
  const strip = (text: string) => textWithoutPreviewedLinkLine(text, url);

  it("removes a bare link on its own line and keeps the text", () => {
    expect(strip(`Voici l'article :\n${url}`)).toBe("Voici l'article :");
    expect(strip(`${url}\nVoici l'article`)).toBe("Voici l'article");
  });

  it("removes the link in angle brackets, as a self-labelled markdown link, or as a bare www. form", () => {
    expect(strip(`Lu :\n<${url}>`)).toBe("Lu :");
    expect(strip(`Lu :\n[${url}](${url})`)).toBe("Lu :");
    expect(textWithoutPreviewedLinkLine("Lu :\nwww.lemonde.fr/x", "https://www.lemonde.fr/x")).toBe(
      "Lu :",
    );
    expect(strip(`Lu :\n  ${url}  `)).toBe("Lu :");
  });

  it("drops the blank line the removal leaves, not the paragraphs around it", () => {
    expect(strip(`Intro\n\n${url}\n\nSuite`)).toBe("Intro\n\nSuite");
    expect(strip(`Intro\n\n${url}`)).toBe("Intro");
    expect(strip(`${url}\n\nSuite`)).toBe("Suite");
    expect(strip(`Intro\n${url}\n\nSuite`)).toBe("Intro\n\nSuite");
    expect(strip(`A\n\nB\n\n${url}\n\nC`)).toBe("A\n\nB\n\nC");
  });

  it("removes every line that is the link", () => {
    expect(strip(`${url}\nPuis\n${url}\nFin`)).toBe("Puis\nFin");
    expect(strip(`Lu\r\n${url}\r\nFin`)).toBe("Lu\nFin");
  });

  it("is empty when nothing but the link remains", () => {
    expect(strip(url)).toBe("");
    expect(strip(`\n${url}\n\n${url}\n`)).toBe("");
  });

  it("keeps a link inside a sentence, a list, a quote, a longer line or another link", () => {
    for (const text of [
      `Regarde ${url} c'est bien`,
      `${url} c'est bien`,
      `- ${url}`,
      `> ${url}`,
      `[l'article](${url})`,
      `${url}.`,
      `${url}/`,
      `${url}?a=1`,
      "https://other.tld/x",
    ]) {
      expect(strip(`Début\n${text}`)).toBe(`Début\n${text}`);
    }
  });

  it("leaves a link in a fenced or indented code block", () => {
    const fenced = `Code :\n\`\`\`\n${url}\n\`\`\`\nFin`;
    expect(strip(fenced)).toBe(fenced);
    const tilde = `~~~\n${url}\n~~~\n${url}`;
    expect(strip(tilde)).toBe(`~~~\n${url}\n~~~`);
    const indented = `Code :\n\n    ${url}`;
    expect(strip(indented)).toBe(indented);
  });

  it("returns the very same text when no line is the link", () => {
    const text = "Rien\n\n\n  à retirer  \n";
    expect(strip(text)).toBe(text);
  });

  it("is only for display: the stored text still carries the link for copy, search and the model", () => {
    const text = `Voici l'article :\n${url}`;
    strip(text);
    expect(blocksToAgentHistoryText([{ kind: "text", text }])).toContain(url);
  });
});

describe("normalizePreviewUrl", () => {
  it("lowercases scheme and host, converts to punycode, drops default ports and the fragment only", () => {
    expect(normalizePreviewUrl("HTTPS://A.TLD:443/x#frag")).toBe("https://a.tld/x");
    expect(normalizePreviewUrl("http://a.tld:80/x")).toBe("http://a.tld/x");
    expect(normalizePreviewUrl("https://bücher.tld/x")).toBe("https://xn--bcher-kva.tld/x");
    expect(normalizePreviewUrl("https://a.tld/X/%2F/?q=%41#")).toBe("https://a.tld/X/%2F/?q=%41");
    expect(normalizePreviewUrl("not a url")).toBeNull();
  });
});

describe("previewSiteLabel", () => {
  it("shows the host of the link, without one leading www.", () => {
    expect(previewSiteLabel("https://www.example.com/a?b=1")).toBe("example.com");
    expect(previewSiteLabel("https://Example.COM/a")).toBe("example.com");
    expect(previewSiteLabel("https://www.www.example.com/")).toBe("www.example.com");
    expect(previewSiteLabel("https://blog.example.com:8443/")).toBe("blog.example.com");
  });

  it("keeps punycode and never truncates", () => {
    expect(previewSiteLabel("https://bücher.de/")).toBe("xn--bcher-kva.de");
    const long = `accounts.google.com.${"evil-subdomain.".repeat(8)}tld`;
    expect(previewSiteLabel(`https://${long}/x`)).toBe(long);
    expect(previewSiteLabel("nonsense")).toBe("");
  });
});

describe("isAuthenticationDestination (CA 71)", () => {
  it("flags Google's account host, an authentication host label and an authentication final segment", () => {
    for (const url of [
      "https://accounts.google.com/signin/v2",
      "https://login.example.com/",
      "https://Sso.Example.com/start",
      "https://example.com/sso",
      "https://example.com/a/sign-in",
      "https://example.com/a/sign_in/",
      "https://example.com/oauth/authorize?client=1",
      "https://example.com/Login",
      "https://example.com/%6Cogin",
      "https://example.com/wp-login.php",
      "https://example.com/login.html",
      "https://example.com/session/new",
      "https://example.com/users/sessions/new",
      "https://example.com/%E0/login",
    ]) {
      expect(isAuthenticationDestination(url), url).toBe(true);
    }
  });

  it("leaves a normal page alone, even one that names a sign-in word elsewhere", () => {
    for (const url of [
      "https://example.com/blog/login-tips",
      "https://example.com/login/help",
      "https://example.com/authors",
      "https://www.example.com/article",
      "https://example.com/login-page.html",
      "https://notlogin.example.com/",
      "https://example.com/news/new",
      "https://example.com/blog/how-to-verify-an-email",
      "not a url",
    ]) {
      expect(isAuthenticationDestination(url), url).toBe(false);
    }
  });

  it("flags a single-use link by any of its path segments: opening it would spend it", () => {
    for (const url of [
      "https://example.com/magic-link/abc123",
      "https://example.com/auth/v1/Verify/abc123",
      "https://example.com/email/confirm/abc123",
      "https://example.com/unsubscribe/abc123",
      "https://example.com/invite/abc123",
      "https://example.com/reset-password/abc123",
      "https://example.com/password_reset/abc123",
      "https://example.com/account/activate/abc123",
    ]) {
      expect(isAuthenticationDestination(url), url).toBe(true);
    }
  });
});

describe("hasSecretParam", () => {
  it("flags every secret-looking parameter name, case-insensitively", () => {
    for (const name of [
      "token",
      "key",
      "secret",
      "sig",
      "signature",
      "code",
      "password",
      "auth",
      "session",
      "magic",
      "reset",
      "unsubscribe",
      "TOKEN",
      "Key",
      "X-Amz-Signature",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Goog-Signature",
      "x-goog-credential",
      "access_token",
      "accessToken",
      "id_token",
      "confirmation_token",
      "api_key",
      "apikey",
      "apiKey",
      "client_secret",
      "jwt",
      "otp",
      "ticket",
      "credential",
    ]) {
      expect(hasSecretParam(`https://a.tld/p?x=1&${name}=v`), name).toBe(true);
    }
  });

  it("ignores values, paths, fragments and lookalike names", () => {
    expect(hasSecretParam("https://a.tld/token/key?q=token")).toBe(false);
    expect(hasSecretParam("https://a.tld/p?monkey=1&tokens=2")).toBe(false);
    expect(
      hasSecretParam(
        "https://a.tld/p?q=a&page=2&keywords=b&keyword=c&utm_source=d&v=dQw4w9WgXcQ&si=e&author=f&codec=g&tickets=h&country_code=fr",
      ),
    ).toBe(false);
    expect(hasSecretParam("https://a.tld/p#token=1")).toBe(false);
    expect(hasSecretParam("https://a.tld/p")).toBe(false);
    expect(hasSecretParam("garbage")).toBe(false);
  });
});

describe("sanitizePreviewTitle", () => {
  it("removes bidi controls, zero-width characters and other control characters", () => {
    expect(sanitizePreviewTitle("Pay‮moc.evil‬ now")).toBe("Paymoc.evil now");
    expect(sanitizePreviewTitle("a⁦b⁩c‎d‏e؜f")).toBe("abcdef");
    expect(sanitizePreviewTitle("ze\u200Bro\u2060wi\uFEFFdth")).toBe("zerowidth");
    // ZWNJ and ZWJ are kept: emoji sequences and some scripts depend on them.
    expect(sanitizePreviewTitle("family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}")).toBe(
      "family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    );
    expect(sanitizePreviewTitle("\u0645\u06CC\u200C\u062E\u0648\u0627\u0645")).toBe(
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0645",
    );
    expect(sanitizePreviewTitle("a\u0000b\u0007c\u007Fd")).toBe("abcd");
    expect(sanitizePreviewTitle("tag\u{E0041}\u{E0042}s")).toBe("tags");
  });

  it("collapses whitespace and keeps text as plain text", () => {
    expect(sanitizePreviewTitle("  a \n\t b  c  ")).toBe("a b c");
    expect(sanitizePreviewTitle("<img src=x onerror=alert(1)> **bold**")).toBe(
      "<img src=x onerror=alert(1)> **bold**",
    );
    expect(sanitizePreviewTitle("​ ‮")).toBe("");
  });

  it("caps at 300 characters without splitting a surrogate pair", () => {
    expect(sanitizePreviewTitle("x".repeat(500))).toHaveLength(300);
    expect(sanitizePreviewTitle("x".repeat(300))).toHaveLength(300);
    const emoji = sanitizePreviewTitle(`${"x".repeat(299)}😀`);
    expect(emoji).toBe("x".repeat(299));
    expect(sanitizePreviewTitle("héllo")).toBe("héllo");
  });
});

describe("link_preview in block consumers", () => {
  const SENTINEL = "SENTINEL-IGNORE-PREVIOUS-INSTRUCTIONS";
  const preview: MessageBlock = {
    kind: "link_preview",
    url: "https://a.tld/x",
    format: "compact",
    title: SENTINEL,
  };
  const marker: MessageBlock = { kind: "link_preview", removed: true, url: "https://a.tld/x" };
  const mention: MessageBlock = { kind: "link_mention", url: "https://a.tld/x", title: SENTINEL };

  it("never reaches the model through blocksToAgentHistoryText", () => {
    const withPreview = blocksToAgentHistoryText([
      { kind: "text", text: "see https://a.tld/x" },
      preview,
      marker,
      mention,
    ]);
    expect(withPreview).toBe(
      blocksToAgentHistoryText([{ kind: "text", text: "see https://a.tld/x" }]),
    );
    expect(withPreview).not.toContain(SENTINEL);
    expect(blocksToAgentHistoryText([preview, marker, mention])).toBe("");
  });

  it("is not read aloud", () => {
    expect(speechFromBlocks([preview, marker, mention])).toBe("");
    expect(speechFromBlocks([{ kind: "text", text: "hi" }, preview, mention])).toBe("hi");
  });

  it("is never an aside", () => {
    expect(isAsideOnlyMessage([preview])).toBe(false);
    expect(isAsideOnlyMessage([mention])).toBe(false);
  });

  it("does not change whether a message groups as narration", () => {
    const text: MessageBlock = { kind: "text", text: "hi" };
    expect(isUserNarrationMessage({ role: "user", blocks: [text, preview] })).toBe(true);
    expect(isNarrationMessage({ role: "bot", blocks: [text, preview] })).toBe(true);
    expect(isNarrationMessage({ role: "bot", blocks: [text, marker] })).toBe(true);
    expect(isUserNarrationMessage({ role: "user", blocks: [text, mention] })).toBe(true);
    expect(isNarrationMessage({ role: "bot", blocks: [text, mention] })).toBe(true);
  });
});

describe("messageHostsLinkPreview", () => {
  const blocks = (...kinds: Array<Record<string, unknown>>) => [
    { kind: "text", text: "x" },
    ...kinds,
  ];

  it("accepts a plain message from a person or a bot", () => {
    expect(messageHostsLinkPreview({ role: "user", blocks: blocks() })).toBe(true);
    expect(
      messageHostsLinkPreview({
        role: "bot",
        blocks: blocks({ kind: "steps" }, { kind: "image" }),
      }),
    ).toBe(true);
  });

  it.each([
    "ask",
    "computer",
    "handoff",
    "channel_message",
    "meta",
    "routine_run",
    "child_bot",
    "mcp_approval",
  ])("refuses a message that holds a %s block", (kind) => {
    expect(messageHostsLinkPreview({ role: "bot", blocks: blocks({ kind }) })).toBe(false);
  });

  it("refuses a choice until it is answered, and a system message always", () => {
    expect(messageHostsLinkPreview({ role: "bot", blocks: blocks({ kind: "choice" }) })).toBe(
      false,
    );
    expect(
      messageHostsLinkPreview({ role: "bot", blocks: blocks({ kind: "choice", answerId: "a" }) }),
    ).toBe(true);
    expect(messageHostsLinkPreview({ role: "system", blocks: blocks() })).toBe(false);
  });

  it("ignores values that are not blocks", () => {
    expect(messageHostsLinkPreview({ role: "bot", blocks: [null, 3, "x", {}] })).toBe(true);
  });
});

describe("previewTitleFromUrl", () => {
  it.each([
    [
      "https://www.lemonde.fr/international/article/2026/10/05/a-kiev-une-atmosphere-de-guerre-permanente-l-ennemi-est-en-train-de-detruire-la-ville_6788472_3210.html",
      "A kiev une atmosphere de guerre permanente l'ennemi est en train de detruire la ville",
    ],
    ["https://a.tld/news/some-story-title-12345", "Some story title"],
    ["https://a.tld/news/some_story_title_123", "Some story title"],
    ["https://a.tld/news/some-story.php?id=3#x", "Some story"],
    ["https://a.tld/news/some-story.HTM", "Some story"],
    ["https://a.tld/news/Un-%C3%A9t%C3%A9-en-Gr%C3%A8ce/", "Un été en Grèce"],
    ["https://a.tld/news/%E0%A4-bad-escape", "%E0%A4 bad escape"],
    ["https://a.tld/news/été-en-grèce", "Été en grèce"],
    ["https://a.tld/a/b//two-words//", "Two words"],
    ["https://www.notion.so/team/Roadmap-Q4-3f9a2c7e81d04b5f9c2a6e1d0b7f4a38", "Roadmap Q4"],
    ["https://www.notion.so/Roadmap-3f9a2c7e81d04b5f9c2a6e1d0b7f4a38", "Roadmap"],
    ["https://a.tld/p/Roadmap-0123456789abcdef", "Roadmap"],
    ["https://a.tld/p/Plan_123e4567-e89b-12d3-a456-426614174000", "Plan"],
    ["https://a.tld/p/release-notes-3F9A2C7E81D04B5F", "Release notes"],
    ["https://a.tld/p/Roadmap-3f9a2c7e", "Roadmap 3f9a2c7e"],
  ])("%s gives %s", (url, title) => {
    expect(previewTitleFromUrl(url)).toBe(title);
  });

  it.each([
    "https://a.tld/",
    "https://a.tld",
    "https://a.tld/politique",
    "https://a.tld/politique.html",
    "https://a.tld/article/6788472_3210",
    "https://a.tld/article/12345",
    "https://a.tld/2026-10-05",
    "https://a.tld/a-1",
    "https://a.tld/12-34-56",
    "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
    "https://a.tld/p/3f9a2c7e81d04b5f9c2a6e1d0b7f4a38",
    "not a url",
  ])("gives no title for %s", (url) => {
    expect(previewTitleFromUrl(url)).toBeNull();
  });

  it("restores French elisions, with the article's own apostrophe and no guessed accent", () => {
    expect(
      previewTitleFromUrl(
        "https://www.lefigaro.fr/actualite-france/j-ai-eu-peur-je-suis-rentre-chez-moi-la-colere-et-l-inquietude-des-eleves-et-leurs-parents-face-aux-violences-devant-les-lycees-20261004",
      ),
    ).toBe(
      "J'ai eu peur je suis rentre chez moi la colere et l'inquietude des eleves et leurs parents face aux violences devant les lycees",
    );
    expect(
      previewTitleFromUrl("https://a.tld/n/qu-il-parte-d-ici-s-en-va-m-ecoute-t-es-c-est-n-hesite"),
    ).toBe("Qu'il parte d'ici s'en va m'ecoute t'es c'est n'hesite");
  });

  it("elides only a lone letter or qu before a vowel or h", () => {
    expect(previewTitleFromUrl("https://a.tld/n/j-mange-l-ours-d-or")).toBe("J mange l'ours d'or");
    expect(previewTitleFromUrl("https://a.tld/n/le-mur-quai-ou-sa-vie")).toBe(
      "Le mur quai ou sa vie",
    );
    expect(previewTitleFromUrl("https://a.tld/n/jai-lami-dhier-ou")).toBe("Jai lami dhier ou");
    expect(previewTitleFromUrl("https://a.tld/n/a-b-c-d-e")).toBe("A b c d'e");
  });

  it("sanitizes what the address decodes to and caps its length", () => {
    expect(previewTitleFromUrl("https://a.tld/pay%E2%80%AEevil-now")).toBe("Payevil now");
    const long = `https://a.tld/${"word-".repeat(200)}end`;
    expect(previewTitleFromUrl(long)).toHaveLength(299);
  });
});

describe("a message's mentions", () => {
  const mention = {
    kind: "link_mention",
    url: "https://www.notion.so/acme/Roadmap-Q4-3f9a2c7e81d04b5f",
    title: "Roadmap Q4",
    icon: { artifactId: "icon-1" },
  } as const;
  const message = (blocks: unknown[], role = "user") => ({
    role,
    blocks: [{ kind: "text", text: "see it" }, ...blocks] as MessageBlock[],
  });

  it("finds a mention by any written form of its link, and nothing for another link", () => {
    const mentions = linkMentionsOf(message([mention]));
    expect(mentions?.find("www.notion.so/acme/Roadmap-Q4-3f9a2c7e81d04b5f")).toBe(mention);
    expect(mentions?.find("https://WWW.notion.so/acme/Roadmap-Q4-3f9a2c7e81d04b5f#h")).toBe(
      mention,
    );
    expect(mentions?.find("https://www.notion.so/acme/Other")).toBeUndefined();
  });

  it("has nothing to find without a mention block or on a message that is itself a card", () => {
    expect(linkMentionsOf(message([]))).toBeUndefined();
    expect(linkMentionsOf(message([mention], "system"))).toBeUndefined();
    expect(linkMentionsOf(message([{ kind: "meta", text: "m" }, mention]))).toBeUndefined();
    expect(linkMentionsOf(message([mention], "bot"))?.find(mention.url)).toBe(mention);
  });

  it("keys a message on its mentions alone, and on nothing when it may carry none", () => {
    expect(linkMentionsKey(message([mention]))).toBe(JSON.stringify([mention]));
    expect(linkMentionsKey(message([mention], "system"))).toBe("");
    expect(linkMentionsKey(message([]))).toBe("[]");
  });

  it("labels a mention with the author's words, then the server's title, then the host", () => {
    const href = "https://www.example.test/doc/abc";
    const titled = { title: "Q4 plan" };
    expect(linkMentionLabel({ href, authorText: "Compte rendu", block: titled })).toBe(
      "Compte rendu",
    );
    expect(linkMentionLabel({ href, authorText: href, block: titled })).toBe("Q4 plan");
    expect(linkMentionLabel({ href, authorText: "www.example.test/doc/abc", block: titled })).toBe(
      "Q4 plan",
    );
    expect(
      linkMentionLabel({ href, authorText: "http://www.example.test/doc/abc#x", block: titled }),
    ).toBe("Q4 plan");
    expect(linkMentionLabel({ href, block: titled })).toBe("Q4 plan");
    expect(linkMentionLabel({ href, authorText: href, block: {} })).toBe("example.test");
    expect(linkMentionLabel({ href, authorText: " ", block: { title: "\u202e " } })).toBe(
      "example.test",
    );
  });

  it("counts a long bare URL and a scheme-less or www-less spelling as the address", () => {
    const long = `https://www.example.test/a/${"x".repeat(400)}`;
    expect(linkMentionLabel({ href: long, authorText: long, block: { title: "Long read" } })).toBe(
      "Long read",
    );
    expect(
      linkMentionLabel({
        href: "https://www.example.test/a",
        authorText: "example.test/a",
        block: { title: "A" },
      }),
    ).toBe("A");
    expect(
      linkMentionLabel({
        href: "https://example.test/a",
        authorText: "www.example.test/a",
        block: { title: "A" },
      }),
    ).toBe("A");
    expect(
      linkMentionLabel({
        href: "https://www.example.test/a",
        authorText: "example.test/b",
        block: { title: "A" },
      }),
    ).toBe("example.test/b");
  });

  it("strips bidirectional controls from a label", () => {
    expect(
      linkMentionLabel({
        href: "https://example.test/a",
        authorText: "invoice\u202Egpj.exe",
        block: {},
      }),
    ).toBe("invoicegpj.exe");
  });
});
