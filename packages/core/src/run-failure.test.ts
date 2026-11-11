import type { RunFailureKind, RunStatus } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { classifyRunFailure } from "./run-failure.js";

describe("classifyRunFailure", () => {
  const failed: Array<[string, string | null, RunFailureKind]> = [
    ["no model connected", "Connect a model in Settings before running bots.", "missing_model"],
    ["model provider not connected", "Connect that model provider first", "missing_model"],
    ["unknown model", "Unknown model for that provider", "missing_model"],
    ["bot without a computer", "Bot has no computer", "computer"],
    ["lease expired", "Computer lease expired before takeover", "computer"],
    [
      "box api failure",
      "Box API request failed (HTTP 502, upstream_unavailable): bad gateway (request req_1)",
      "computer",
    ],
    ["provider rate limit", "429 Too Many Requests: rate limit reached", "provider"],
    ["provider auth", "401 Unauthorized: invalid api key", "provider"],
    ["provider overloaded", "Overloaded", "provider"],
    [
      "opencode session",
      "OpenCode rejected this chat session. Send the message again.",
      "provider",
    ],
    ["provider billing", "400 Your credit balance is too low", "provider"],
    ["provider server error", "529 Overloaded", "provider"],
    ["tool not found", "web_fetch failed: 404 Not Found", "other"],
    ["tool naming a model", "Tool error: model file missing", "other"],
    ["network failure", "fetch failed", "other"],
    ["pause for approval", "Could not pause this run for approval; try sending again.", "other"],
    [
      "pause for protected input",
      "Could not pause this run for protected input; try sending again.",
      "other",
    ],
    ["secret guard", "refusing to persist a secret in the thread", "other"],
    ["empty text", "", "other"],
    ["blank text", "   ", "other"],
    ["missing text", null, "other"],
  ];

  it.each(failed)("classifies a failed run: %s", (_name, error, kind) => {
    expect(classifyRunFailure("failed", error)).toBe(kind);
  });

  it.each<RunStatus>([
    "queued",
    "leased",
    "running",
    "waiting_input",
    "waiting_takeover",
    "completed",
    "cancelled",
  ])("returns null for a %s run even with error text", (status) => {
    expect(classifyRunFailure(status, "Bot has no computer")).toBeNull();
  });
});
