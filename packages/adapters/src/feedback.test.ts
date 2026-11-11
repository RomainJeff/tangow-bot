import type { AdapterContext } from "@tangow/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackInput } from "./feedback.js";
import { createFeedbackProvider, feedbackIssue } from "./feedback.js";
import { GithubFeedbackProvider } from "./github-feedback.js";

const context = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

const input: FeedbackInput = {
  kind: "excessive_steps",
  summary: "Saving a draft took twelve browser actions\nThe save button moved after each click.",
  expected: "One click saves the draft",
  impact: "completed_with_difficulty",
  tool: "browser_act",
};

describe("feedbackIssue", () => {
  it("keeps the agent's assessment apart from what Tangow measured", () => {
    const issue = feedbackIssue(input, {
      runId: "run-1",
      threadId: "thread-1",
      botId: "bot-1",
      model: "openai/gpt-test",
      harness: "worker",
      version: undefined,
      reportedAt: new Date("2026-11-01T10:00:00.000Z"),
      measurements: { elapsedSeconds: 95, modelCalls: 14, toolCalls: 22, failedToolCalls: 3 },
    });

    expect(issue.title).toBe("Saving a draft took twelve browser actions");
    expect(issue.labels).toEqual(["agent-feedback", "friction"]);
    const [reported, observed] = issue.body.split("## Observed by Tangow");
    expect(reported).toContain("The save button moved after each click.");
    expect(reported).toContain("**Impact:** Completed with difficulty");
    expect(observed).toContain("- Run: `run-1`");
    expect(observed).toContain("not final totals");
    expect(observed).toContain("- Model calls recorded: 14 (compaction calls included");
    expect(observed).toContain("- Tool calls audited: 22, 3 failed (the audit can miss calls)");
    expect(observed).not.toContain("Tangow version");
  });

  it.each([
    ["blocked", ["agent-feedback", "blocked"]],
    ["malfunction", ["agent-feedback", "bug"]],
    ["other", ["agent-feedback"]],
  ] as const)("labels %s feedback", (kind, labels) => {
    const issue = feedbackIssue(
      { ...input, kind },
      {
        runId: "run-1",
        threadId: "thread-1",
        botId: "bot-1",
        model: undefined,
        harness: "worker",
        version: "abc123",
        reportedAt: new Date(),
        measurements: {
          elapsedSeconds: undefined,
          modelCalls: 0,
          toolCalls: 0,
          failedToolCalls: 0,
        },
      },
    );
    expect(issue.labels).toEqual(labels);
  });
});

describe("createFeedbackProvider", () => {
  it("offers nothing until the operator picks a provider", () => {
    expect(createFeedbackProvider({})).toBeUndefined();
  });

  it.each([
    [{ FEEDBACK_PROVIDER: "linear" }, 'Unknown feedback provider "linear"'],
    [
      { FEEDBACK_PROVIDER: "github", FEEDBACK_GITHUB_REPOSITORY: "https://github.com/acme/repo" },
      "owner/name",
    ],
    [
      { FEEDBACK_PROVIDER: "github", FEEDBACK_GITHUB_REPOSITORY: "acme/feedback" },
      "Missing FEEDBACK_GITHUB_TOKEN",
    ],
  ])("refuses an incomplete setup at startup (%o)", (source, message) => {
    expect(() => createFeedbackProvider(source)).toThrow(message);
  });
});

describe("GithubFeedbackProvider", () => {
  const issue = { title: "Title", body: "Body", labels: ["agent-feedback", "bug"] };

  it("creates the issue in the configured repository and returns its URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ html_url: "https://github.com/acme/feedback/issues/7" }), {
          status: 201,
        }),
    );
    const provider = new GithubFeedbackProvider({
      repository: "acme/feedback",
      token: "test-token",
      fetch,
    });

    await expect(provider.deliver(issue, context)).resolves.toEqual({
      url: "https://github.com/acme/feedback/issues/7",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/acme/feedback/issues");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    expect(JSON.parse(String(init?.body))).toEqual(issue);
  });

  it("fails with GitHub's status and reason only", async () => {
    const provider = new GithubFeedbackProvider({
      repository: "acme/feedback",
      token: "test-token",
      fetch: async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    });

    await expect(provider.deliver(issue, context)).rejects.toThrow(
      /^GitHub did not create the issue \(HTTP 404: Not Found\)$/,
    );
  });
});
