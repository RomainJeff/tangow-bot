import { TraceExporter } from "@rakazo/adapters";
import type { WorkerTrace } from "@rakazo/adapters/runtime-worker";
import { describe, expect, it, onTestFinished } from "vitest";
import { startWorkerRun } from "./worker-run-fixture.js";

const SECRET = "fake-run-secret-7Q2";

/**
 * One worker run: a native bash call, a controller tool call, then a reply with cached tokens.
 * Resolves with the run's final status.
 */
async function runShowingKey(trace: WorkerTrace) {
  const run = await startWorkerRun({
    secrets: [SECRET],
    trace,
    steps: [
      {
        expect() {},
        response: {
          type: "tool",
          id: "call-bash",
          name: "bash",
          arguments: { command: `echo ${SECRET}` },
        },
      },
      {
        expect() {},
        response: {
          type: "tool",
          id: "call-message",
          name: "message_user",
          arguments: { message: `Your key is ${SECRET}.` },
        },
      },
      {
        expect() {},
        response: {
          type: "text",
          text: JSON.stringify({ version: 1, results: ["Sent"], references: [] }),
          usage: { promptTokens: 210, completionTokens: 12, cacheReadTokens: 64 },
        },
      },
    ],
  });
  onTestFinished(() => run.close());
  const runId = await run.send("Show my key.");
  await run.continueRun(runId);
  return (await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).status;
}

type ExportedSpan = {
  name: string;
  parentSpanId?: string;
  status: { code: number };
  attributes: Array<{ key: string; value: { stringValue?: string } }>;
};

describe("a traced worker run", () => {
  it("exports the run, each relayed model request and each tool call, with secrets masked", async () => {
    const payloads: unknown[] = [];
    const exporter = new TraceExporter({ send: async (payload) => void payloads.push(payload) });
    expect(await runShowingKey({ exporter, serviceName: "rakazo-worker" })).toBe("completed");
    await exporter.flush();

    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads)).not.toContain(SECRET);
    const spans = (payloads[0] as { resourceSpans: [{ scopeSpans: [{ spans: ExportedSpan[] }] }] })
      .resourceSpans[0].scopeSpans[0].spans;
    const attributes = (span: ExportedSpan) =>
      Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue]));
    const [root, ...children] = spans;
    expect(root?.name).toBe("rakazo.run");
    const named = new Map(children.map((span) => [span.name, span]));
    expect([...named.keys()].sort()).toEqual([
      "generation 1",
      "generation 2",
      "generation 3",
      "tool bash",
      "tool message_user",
    ]);
    expect(children.every((span) => span.parentSpanId && span.status.code === 1)).toBe(true);
    const first = attributes(named.get("generation 1")!);
    const second = attributes(named.get("generation 2")!);
    const third = attributes(named.get("generation 3")!);
    expect(first["langfuse.observation.input"]).toContain("Show my key.");
    expect(JSON.parse(first["langfuse.observation.output"]!)).toMatchObject({
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: "echo [redacted]" } }],
    });
    expect(second["langfuse.observation.input"]).toContain("toolResult");
    expect(second["langfuse.observation.output"]).toContain("Your key is [redacted].");
    expect(JSON.parse(third["langfuse.observation.output"]!)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: '{"version":1,"results":["Sent"],"references":[]}' }],
    });
    // The relay counts cached prompt tokens as input; the trace reports them apart.
    expect(
      JSON.parse(attributes(named.get("generation 3")!)["langfuse.observation.usage_details"]!),
    ).toMatchObject({ input: 146, cache_read: 64, output: 12 });
    expect(attributes(named.get("tool bash")!)["langfuse.observation.input"]).toContain(
      "[redacted]",
    );
  });
});
