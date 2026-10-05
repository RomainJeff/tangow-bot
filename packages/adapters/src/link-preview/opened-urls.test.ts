import type { AgentToolCompletion } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { appendToolCompletionAudit, toolCompletionAuditPayload } from "../executor.js";
import { OPENED_URLS_PER_RUN, openedUrlFromCompletion, readOpenedUrls } from "./opened-urls.js";

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

    const urls = await readOpenedUrls({ event: { findMany } } as never, "run-1");

    expect(urls).toEqual(["https://a.test/1", "https://a.test/3"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "run-1", type: "agent.tool.completed" } }),
    );
  });

  it("stops at 50", async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      payload: { openedUrl: `https://a.test/${index}` },
    }));
    const urls = await readOpenedUrls({ event: { findMany: async () => rows } } as never, "run-1");
    expect(urls).toHaveLength(50);
    expect(urls.at(-1)).toBe("https://a.test/49");
  });
});
