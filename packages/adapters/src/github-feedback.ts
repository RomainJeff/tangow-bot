import type { AdapterContext, FeedbackIssue, FeedbackProvider } from "@tangow/adapter-kit";
import { z } from "zod";
import { combineSignals } from "./connector-safety.js";

export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const CreatedIssue = z.object({ html_url: z.string().url() });
const GithubError = z.object({ message: z.string() });

/** Files agent feedback as an issue in one GitHub repository the operator chose. */
export class GithubFeedbackProvider implements FeedbackProvider {
  private readonly repository: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: {
    repository: string;
    token: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  }) {
    this.repository = options.repository;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async deliver(issue: FeedbackIssue, context: AdapterContext): Promise<{ url: string }> {
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${this.repository}/issues`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "user-agent": "rakazo-feedback",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify(issue),
        signal: combineSignals(context.signal, AbortSignal.timeout(this.timeoutMs)),
      },
    );
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const refusal = GithubError.safeParse(body);
      throw new Error(
        `GitHub did not create the issue (HTTP ${response.status}${refusal.success ? `: ${refusal.data.message.slice(0, 200)}` : ""})`,
      );
    }
    const created = CreatedIssue.safeParse(body);
    if (!created.success)
      throw new Error("GitHub answered without an issue URL, so the issue may exist anyway");
    return { url: created.data.html_url };
  }
}
