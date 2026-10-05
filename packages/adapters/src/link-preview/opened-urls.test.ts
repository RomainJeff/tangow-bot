import { createHash } from "node:crypto";
import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { appendToolCompletionAudit, toolCompletionAuditPayload } from "../executor.js";
import {
  OPENED_URLS_PER_RUN,
  openedUrlFromCompletion,
  readRunLinkSources,
  SEEN_URLS_PER_RUN,
  seenUrlHash,
  seenUrlHashesFromCompletion,
} from "./opened-urls.js";

const RUN = "run-1";
const fetched = { text: "page", url: "https://final.test/after-redirect" };
const completion = (overrides: Record<string, unknown> = {}) =>
  ({
    name: "web_fetch",
    executionId: "call-1",
    durationMs: 5,
    args: { url: "https://a.test/x" },
    // What the runtime hands back: the raw tool result under `details`.
    result: { content: [{ type: "text", text: "page" }], details: fetched },
    ...overrides,
  }) as AgentToolCompletion;

describe("which URL a finished tool call opened (CA 27)", () => {
  it("records the requested URL of a web_fetch, never the final URL of a redirect", () => {
    expect(openedUrlFromCompletion(completion())).toBe("https://a.test/x");
  });

  it("records a browser_navigate too, trimmed like the tool trims it", () => {
    expect(
      openedUrlFromCompletion(
        completion({
          name: "browser_navigate",
          args: { url: "  https://a.test/y " },
          result: { ok: true },
        }),
      ),
    ).toBe("https://a.test/y");
  });

  it("reads a scripted tool's raw result as well", () => {
    expect(openedUrlFromCompletion(completion({ result: fetched }))).toBe("https://a.test/x");
  });

  it.each([
    ["web_search", { name: "web_search" }],
    ["browser_snapshot", { name: "browser_snapshot" }],
    ["browser_act", { name: "browser_act" }],
    ["run_subagent", { name: "run_subagent" }],
    ["a subagent's call", { nested: true }],
    ["a call that threw", { error: new Error("blocked") }],
    ["a paused call", { paused: true }],
    ["a result that carries an error", { result: { content: [], details: { error: "403" } } }],
    ["a result that asks for a fallback", { result: { error: "x", fallback: "computer_act" } }],
    ["an uncertain, not replayed call", { result: { error: "x", uncertain: true } }],
    ["a result that is not ok", { result: { ok: false } }],
    ["no result at all", { result: undefined }],
    ["no url argument", { args: {} }],
    ["a url that is not a string", { args: { url: 12 } }],
    ["a url with credentials", { args: { url: "https://u:p@a.test/x" } }],
    ["a url that is not http(s)", { args: { url: "ftp://a.test/x" } }],
    ["a url over 2048 characters", { args: { url: `https://a.test/${"a".repeat(2100)}` } }],
  ])("records nothing for %s", (_name, overrides) => {
    expect(openedUrlFromCompletion(completion(overrides))).toBeUndefined();
  });
});

describe("the audit event keeps that one URL and nothing else of the arguments", () => {
  it("adds openedUrl and no other argument", () => {
    const payload = toolCompletionAuditPayload(
      completion({ args: { url: "https://a.test/x", maxChars: 100, secret_note: "nope" } }),
    );
    expect(payload.openedUrl).toBe("https://a.test/x");
    expect(JSON.stringify(payload)).not.toContain("secret_note");
    expect(JSON.stringify(payload)).not.toContain("after-redirect");
  });

  it("drops a URL that redaction changes: it can never match a link in a message", () => {
    const payload = toolCompletionAuditPayload(
      completion({ args: { url: "https://a.test/x?k=hunter2-secret" } }),
      ["hunter2-secret"],
    );
    expect(payload).not.toHaveProperty("openedUrl");
  });

  it("keeps at most 50 per run", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const budget = { remaining: OPENED_URLS_PER_RUN };
    for (let index = 0; index < 60; index += 1) {
      await appendToolCompletionAudit(
        { events: { append } },
        { spaceId: "s", threadId: "t", botId: "b", runId: "r" },
        completion({ args: { url: `https://a.test/${index}` } }),
        [],
        budget,
      );
    }
    const recorded = append.mock.calls.filter(([event]) => event.payload.openedUrl !== undefined);
    expect(recorded).toHaveLength(50);
    expect(append).toHaveBeenCalledTimes(60);
  });
});

describe("reading them back", () => {
  it("reads by exact run id and ignores events that carry nothing valid", async () => {
    const findMany = vi.fn(async () => [
      { payload: { openedUrl: "https://a.test/1" } },
      { payload: { name: "computer_observe" } },
      { payload: { openedUrl: "javascript:alert(1)" } },
      { payload: { openedUrl: "https://u:p@a.test/2" } },
      { payload: { openedUrl: 42 } },
      { payload: "x" },
      { payload: { openedUrl: "https://a.test/3" } },
    ]);

    const { opened: urls } = await readRunLinkSources({ event: { findMany } } as never, "run-1");

    expect(urls).toEqual(["https://a.test/1", "https://a.test/3"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "run-1", type: "agent.tool.completed" } }),
    );
  });

  it("stops at 50", async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      payload: { openedUrl: `https://a.test/${index}` },
    }));
    const { opened: urls } = await readRunLinkSources(
      { event: { findMany: async () => rows } } as never,
      "run-1",
    );
    expect(urls).toHaveLength(50);
    expect(urls.at(-1)).toBe("https://a.test/49");
  });
});

describe("links a public web tool showed the bot (CA 58-60)", () => {
  const search = {
    name: "web_search",
    args: { query: "frandroid" },
    result: {
      content: [{ type: "text", text: "..." }],
      details: {
        results: [
          { title: "A", url: "https://hit.test/a#x", snippet: "also https://snip.test/s." },
          { title: "B", url: "https://hit.test/b", snippet: "" },
        ],
      },
    },
  };

  it("hashes the hits of a web_search, normalized", () => {
    expect(seenUrlHashesFromCompletion(completion(search), RUN)).toEqual(
      ["https://hit.test/a", "https://snip.test/s", "https://hit.test/b"].map((url) =>
        seenUrlHash(RUN, url),
      ),
    );
  });

  it("reads the links of a fetched page, including its final URL", () => {
    const text = "Home https://page.test/one and [two](https://page.test/two)";
    expect(
      seenUrlHashesFromCompletion(
        completion({
          result: { content: [], details: { url: "https://final.test/z", text } },
        }),
        RUN,
      ),
    ).toEqual(
      ["https://final.test/z", "https://page.test/one", "https://page.test/two"].map((url) =>
        seenUrlHash(RUN, url),
      ),
    );
  });

  describe("never from the logged-in browser (M1)", () => {
    const snapshot = {
      url: "https://a.test/x",
      location: { href: "https://evil.tld/c?d=private" },
      tree: "textbox value=https://evil.tld/c?d=private\nlink https://svc.tld/confirm/AbC123",
      elements: [
        { ref: "e1", role: "textbox", name: "Search", value: "https://evil.tld/c?d=private" },
        { ref: "e2", role: "link", name: "Confirm", value: "https://svc.tld/confirm/AbC123" },
      ],
    };

    it.each(["browser_snapshot", "browser_navigate"])("records nothing from %s", (name) => {
      const done = completion({
        name,
        args: { url: "https://a.test/x" },
        result: { content: [], details: snapshot },
      });
      expect(seenUrlHashesFromCompletion(done, RUN)).toEqual([]);
      expect(toolCompletionAuditPayload(done, [], RUN)).not.toHaveProperty("seenUrlHashes");
    });

    it("still records the URL a browser_navigate was asked to open, as before", () => {
      const payload = toolCompletionAuditPayload(
        completion({
          name: "browser_navigate",
          args: { url: "https://a.test/x" },
          result: { content: [], details: snapshot },
        }),
        [],
        RUN,
      );
      expect(payload.openedUrl).toBe("https://a.test/x");
    });
  });

  it.each([
    ["an MCP tool", { name: "mcp__mail__read" }],
    ["an email tool", { name: "email_read" }],
    ["a Notion tool", { name: "notion_page" }],
    ["memory", { name: "recall_memory" }],
    ["a shell command", { name: "shell" }],
    ["a computer observation", { name: "computer_observe" }],
    ["a file read", { name: "read_file" }],
    ["browser_act", { name: "browser_act" }],
    ["a subagent's call", { nested: true }],
    ["a call that threw", { error: new Error("blocked") }],
    ["a paused call", { paused: true }],
    ["a result that carries an error", { result: { content: [], details: { error: "403" } } }],
  ])("records nothing from %s", (_name, overrides) => {
    expect(seenUrlHashesFromCompletion(completion({ ...search, ...overrides }), RUN)).toEqual([]);
  });

  it("drops a link that redaction would change, or that names a secret", () => {
    const hashes = seenUrlHashesFromCompletion(
      completion({
        ...search,
        result: {
          content: [],
          details: {
            text: "https://ok.test/a https://k.test/x?k=hunter2-secret https://s.test/?token=abc",
          },
        },
      }),
      RUN,
      ["hunter2-secret"],
    );
    expect(hashes).toEqual([seenUrlHash(RUN, "https://ok.test/a")]);
  });

  it("checks redaction on the link as written, before normalization (M5)", () => {
    // The URL parser would write "é" as %C3%A9, hiding the secret from a check on that form.
    const hashes = seenUrlHashesFromCompletion(
      completion({
        ...search,
        result: {
          content: [],
          details: { text: "https://k.test/caf\u00e9-secret https://ok.test/a" },
        },
      }),
      RUN,
      ["caf\u00e9-secret"],
    );
    expect(hashes).toEqual([seenUrlHash(RUN, "https://ok.test/a")]);
  });

  it("salts every hash with the run id (M4)", () => {
    const url = "https://hit.test/a";
    expect(seenUrlHash("run-1", url)).toMatch(/^[0-9a-f]{64}$/);
    expect(seenUrlHash("run-1", url)).toBe(seenUrlHash("run-1", `${url}#frag`));
    expect(seenUrlHash("run-1", url)).not.toBe(seenUrlHash("run-2", url));
    expect(seenUrlHash("run-1", url)).toBe(
      createHash("sha256").update(`run-1\n${url}`).digest("hex"),
    );
  });

  it("stores hashes only, never a seen URL in clear, and keeps openedUrl as it was", () => {
    const payload = toolCompletionAuditPayload(
      completion({
        args: { url: "https://a.test/x" },
        result: {
          content: [],
          details: { text: "https://private-looking.test/path?x=1 https://other.test/a" },
        },
      }),
      [],
      RUN,
    );
    expect(payload.openedUrl).toBe("https://a.test/x");
    expect(payload.seenUrlHashes).toEqual(
      ["https://private-looking.test/path?x=1", "https://other.test/a"].map((url) =>
        seenUrlHash(RUN, url),
      ),
    );
    const json = JSON.stringify(payload);
    expect(json).not.toContain("private-looking");
    expect(json).not.toContain("other.test");
    expect(payload.seenUrlHashes).toSatisfy((hashes: string[]) =>
      hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)),
    );
  });

  it("writes no field when nothing was seen", () => {
    expect(
      toolCompletionAuditPayload(completion({ result: { content: [], details: {} } }), [], RUN),
    ).not.toHaveProperty("seenUrlHashes");
  });

  it("keeps at most 300 distinct hashes per run, across calls", async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const openedBudget = { remaining: OPENED_URLS_PER_RUN };
    const seenBudget = { hashes: new Set<string>() };
    for (let call = 0; call < 4; call += 1) {
      await appendToolCompletionAudit(
        { events: { append } },
        { spaceId: "s", threadId: "t", botId: "b", runId: "r" },
        completion({
          name: "web_search",
          args: { query: "q" },
          result: {
            content: [],
            details: {
              results: Array.from({ length: 100 }, (_, index) => ({
                url: `https://hit.test/${call * 90 + index}`,
              })),
            },
          },
        }),
        [],
        openedBudget,
        seenBudget,
      );
    }
    const recorded = append.mock.calls.flatMap(
      ([event]) => (event.payload.seenUrlHashes ?? []) as string[],
    );
    expect(recorded).toHaveLength(SEEN_URLS_PER_RUN);
    expect(new Set(recorded).size).toBe(SEEN_URLS_PER_RUN);
  });

  it("reads them back by exact run id, valid hashes only", async () => {
    const valid = seenUrlHash(RUN, "https://hit.test/a")!;
    const findMany = vi.fn(async () => [
      { payload: { seenUrlHashes: [valid, "nope", 1] } },
      { payload: { seenUrlHashes: "x" } },
      { payload: { openedUrl: "https://a.test/1" } },
    ]);
    const sources = await readRunLinkSources({ event: { findMany } } as never, "run-1");
    expect([...sources.seenHashes]).toEqual([valid]);
    expect(sources.opened).toEqual(["https://a.test/1"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "run-1", type: "agent.tool.completed" } }),
    );
  });
});
