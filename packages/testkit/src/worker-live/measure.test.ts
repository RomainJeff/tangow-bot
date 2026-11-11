import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ModelEmulatorStep } from "../model-emulator.js";
import { prepares } from "../model-emulator.js";
import { VolumeComputer } from "../volume-computer.js";
import type { ScenarioId, TurnRecord } from "./measure.js";
import { measureTokens, resolveModels, stableLocalWorkers } from "./measure.js";
import { measureReceipt, persistentEstimate, summarize } from "./measure-receipt.js";

const usage = { promptTokens: 1000, completionTokens: 20, cacheReadTokens: 600 };
const text = (reply: string): ModelEmulatorStep => ({
  expect() {},
  response: { type: "text", text: reply, usage },
});
const tool = (id: string, name: string, args: Record<string, unknown>): ModelEmulatorStep => ({
  expect() {},
  response: { type: "tool", id, name: `mcp__tangow__${name}`, arguments: args, usage },
});

/** A turn's answer, sent to the person, then the turn's end. */
const say = (reply: string) => [tool("say", "message_user", { message: reply }), text("")];

const SCRIPTS: Record<ScenarioId, ModelEmulatorStep[]> = {
  chain: [...say("Repeated prefixes."), ...say("Cheaper."), ...say("Faster.")],
  computer: [tool("look", "computer_observe", {}), ...say("Example Domain."), ...say("Nothing.")],
  approval: [1, 2].flatMap((note) => [
    tool(`publish-${note}`, "publish_note", { title: `Measurement ${note}` }),
    prepares(),
    text("Waiting for approval."),
    ...say("Published."),
  ]),
  compaction: [
    ...say("One."),
    ...say("Two."),
    ...say("Three."),
    { expect() {}, response: { type: "text", text: "Excerpts one and two." } },
    { expect() {}, response: { type: "text", text: "Three log excerpts." } },
    ...say("Workers."),
    ...say("Batches."),
  ],
};

describe("token and cache measurements", () => {
  it("preserves numeric measurements while redacting sandbox identifiers", () => {
    expect(
      measureReceipt(
        {
          durationMs: 0.00012345678901234567,
          error: "sandbox h3k9d2m7p4x8c1v6b5n0 did not start",
        },
        [],
        [],
        {},
      ),
    ).toMatchObject({
      durationMs: 0.00012345678901234567,
      error: "sandbox <e2b-id> did not start",
    });
  });

  it("records every relayed request of each scenario through a catalog model's own protocol", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tangow-measure-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const models = resolveModels("opencode-go", ["glm-*-flash"]);
    const workers = stableLocalWorkers(path.join(root, "workers"));
    const threads = await measureTokens({
      models,
      protocol: {
        scenarios: ["chain", "computer", "approval", "compaction"],
        trials: 1,
        gapsMs: [0, 5],
        approvalDelaysMs: [0, 5],
      },
      upstream: { script: (scenario) => SCRIPTS[scenario] },
      provider: () => workers.provider,
      sandbox: () => new VolumeComputer((ref) => workers.local.volumePath(ref)),
    });

    expect(
      threads.map((thread) => [thread.scenario, thread.turns.map((turn) => turn.status)]),
    ).toEqual([
      ["chain", ["completed", "completed", "completed"]],
      ["computer", ["completed", "completed"]],
      ["approval", ["completed", "completed"]],
      ["compaction", ["completed", "completed", "completed", "completed", "completed"]],
    ]);
    const [chain, , approval, compaction] = threads;
    expect(chain!.turns[1]!.requests[0]).toEqual(
      expect.objectContaining({
        agent: "root",
        usageReported: true,
        inputTokens: 1000,
        cacheReadTokens: 600,
        outputTokens: 20,
        previousRequest: true,
        firstDivergingSection: "history",
      }),
    );
    expect(
      approval!.turns.map((turn) => [
        turn.approvalRequested,
        typeof turn.restoreOutsideProvisioningMs,
        new Set(turn.requests.map((request) => request.attemptId)).size,
      ]),
    ).toEqual([
      [true, "number", 2],
      [true, "number", 2],
    ]);
    const [, , beforeCompaction, afterCompaction] = compaction!.turns;
    expect(afterCompaction!.compacted).toBe(true);
    expect(afterCompaction!.requests[0]!.promptBytes).toBeLessThan(
      beforeCompaction!.requests[0]!.promptBytes!,
    );
    for (const turn of threads.flatMap((thread) => thread.turns)) {
      expect(turn.appends.length).toBeGreaterThan(0);
      expect(turn.appends.every((append) => append.queries > 0)).toBe(true);
    }

    for (const thread of threads.slice(1)) {
      expect(thread.sharedBase!.sharedChars).toBeGreaterThan(0);
      expect(thread.sharedBase!.sharedChars).toBeLessThan(thread.sharedBase!.nonceAt);
      expect(thread.sharedBase!.toolsAt).toBeGreaterThan(thread.sharedBase!.sharedChars);
    }

    const summary = summarize(threads, models)[models[0]!.id]!;
    expect(summary).toMatchObject({
      cache: {
        mode: "automatic",
        markersSent: false,
        readsReported: true,
        writesReported: false,
      },
      requests: 29,
      threadErrors: 0,
      requestsWithoutUsage: 0,
      successRate: 1,
    });

    const template = "q7m2x9c4v1b8n5z3k6j0";
    const receipt = JSON.stringify(
      measureReceipt(
        { computerTemplate: template },
        [{ ...chain!, error: "sandbox h3k9d2m7p4x8c1v6b5n0 did not start" }],
        models,
        { [template]: "validated private computer" },
      ),
    );
    expect(receipt).toContain('"computerTemplate":"validated private computer"');
    expect(receipt).toContain('"error":"sandbox <e2b-id> did not start"');
    expect(receipt).not.toMatch(/q7m2x9c4v1b8n5z3k6j0|h3k9d2m7p4x8c1v6b5n0/);
  }, 120_000);

  it("estimates one persistent native session from the projection's own requests", () => {
    const request = (
      attemptId: string,
      inputTokens: number,
      cacheReadTokens: number,
      outputTokens: number,
      promptBytes: number,
      commonPrefixBytes: number,
    ) => ({
      attemptId,
      agent: "root",
      usageReported: true,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      outputTokens,
      promptBytes,
      commonPrefixBytes,
      sinceSameModelMs: null,
    });
    const turn = (requests: TurnRecord["requests"], compacted = false): TurnRecord => ({
      waitMs: 0,
      compacted,
      status: "completed",
      approvalRequested: false,
      appends: [],
      requests,
    });
    const turns = [
      turn([request("a1", 1000, 0, 50, 4000, 0), request("a1", 1200, 1000, 30, 4800, 4000)]),
      turn([
        request("a2", 1100, 800, 40, 4400, 4000),
        { ...request("a2", 9000, 0, 900, 9000, 0), agent: "helper" },
        { ...request("a2", 0, 0, 0, 0, 0), usageReported: false },
      ]),
      turn([request("a3", 900, 500, 10, 3600, 1000)], true),
    ];

    expect(persistentEstimate(turns, false)).toEqual({
      projection: { uncached: 1900, cacheRead: 2300, cacheWrite: 0, output: 130 },
      persistent: { uncached: 1730, cacheRead: 2700, cacheWrite: 0, output: 130 },
    });
    expect(persistentEstimate(turns, true).persistent).toEqual({
      uncached: 0,
      cacheRead: 2700,
      cacheWrite: 1730,
      output: 130,
    });
  });
});
