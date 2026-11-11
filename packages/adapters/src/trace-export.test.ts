import { describe, expect, it } from "vitest";

import { RunTrace } from "./run-trace.js";
import {
  encodeTrace,
  resolveTraceExportConfig,
  type TraceExportClient,
  TraceExporter,
} from "./trace-export.js";

const KEYS = { LANGFUSE_PUBLIC_KEY: "pk-placeholder", LANGFUSE_SECRET_KEY: "sk-placeholder" };

function recordedTrace(): RunTrace {
  const trace = new RunTrace({ now: () => 1_000 });
  const root = trace.openSpan({ name: "tangow.run", attributes: { "langfuse.user.id": "user-1" } });
  const child = trace.openSpan(
    { name: "generation 1", attributes: { "langfuse.observation.input": "token is hunter2" } },
    root,
  );
  child?.end();
  root?.end();
  return trace;
}

class FakeClient implements TraceExportClient {
  readonly payloads: unknown[] = [];
  failures = 0;
  constructor(private readonly fail = false) {}
  async send(payload: unknown): Promise<void> {
    if (this.fail) {
      this.failures += 1;
      throw new Error("endpoint unreachable");
    }
    this.payloads.push(payload);
  }
}

describe("resolveTraceExportConfig", () => {
  it("stays silent and off when nothing is configured", () => {
    expect(resolveTraceExportConfig({})).toEqual({});
  });

  it("warns once and stays off when only part of the configuration is present", () => {
    const resolved = resolveTraceExportConfig({ LANGFUSE_PUBLIC_KEY: "pk-placeholder" });
    expect(resolved.config).toBeUndefined();
    expect(resolved.warning).toMatch(/LANGFUSE_SECRET_KEY/);
  });

  it("defaults the endpoint and accepts a full configuration", () => {
    expect(resolveTraceExportConfig({ ...KEYS }).config).toEqual({
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "pk-placeholder",
      secretKey: "sk-placeholder",
      environment: undefined,
    });
  });

  it("rejects endpoints that are unsafe or unparsable", () => {
    expect(resolveTraceExportConfig({ ...KEYS, LANGFUSE_BASE_URL: "not a url" }).warning).toMatch(
      /valid URL/,
    );
    expect(
      resolveTraceExportConfig({ ...KEYS, LANGFUSE_BASE_URL: "http://traces.example.com" }).warning,
    ).toMatch(/https/);
    expect(
      resolveTraceExportConfig({ ...KEYS, LANGFUSE_BASE_URL: "https://user:pass@example.com" })
        .warning,
    ).toMatch(/credentials/);
  });

  it("allows plain http only for a loopback self-host", () => {
    expect(
      resolveTraceExportConfig({ ...KEYS, LANGFUSE_BASE_URL: "http://localhost:3000/" }).config
        ?.baseUrl,
    ).toBe("http://localhost:3000");
  });
});

describe("encodeTrace", () => {
  it("emits an OTLP request with redacted content and parent links", () => {
    const payload = encodeTrace(recordedTrace(), {
      serviceName: "tangow-worker",
      environment: "staging",
      redact: (text) => text.replaceAll("hunter2", "[redacted]"),
    }) as {
      resourceSpans: [{ scopeSpans: [{ spans: Record<string, unknown>[] }] }];
    };
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(2);
    expect(spans[0]?.spanId).toBe("0000000000000001");
    expect(spans[0]?.parentSpanId).toBeUndefined();
    expect(spans[1]?.parentSpanId).toBe("0000000000000001");
    expect(spans[0]?.startTimeUnixNano).toBe("1000000000");
    expect(JSON.stringify(payload)).toContain("[redacted]");
    expect(JSON.stringify(payload)).not.toContain("hunter2");
    expect(JSON.stringify(payload)).toContain("staging");
  });

  it("sends nothing when a run recorded no settled span", () => {
    expect(encodeTrace(new RunTrace())).toBeUndefined();
  });
});

describe("TraceExporter", () => {
  it("exports every run once an endpoint is configured", async () => {
    const client = new FakeClient();
    const exporter = new TraceExporter(client);
    exporter.export(recordedTrace(), { userId: "user-1", spaceId: "space-1" });
    await exporter.flush();
    expect(client.payloads).toHaveLength(1);
  });

  it("exports a run that has no authenticated user", async () => {
    const client = new FakeClient();
    const exporter = new TraceExporter(client);
    exporter.export(recordedTrace(), {});
    await exporter.flush();
    expect(client.payloads).toHaveLength(1);
  });

  it("swallows a failing endpoint and still resolves its flush", async () => {
    const client = new FakeClient(true);
    const exporter = new TraceExporter(client);
    expect(() =>
      exporter.export(recordedTrace(), { userId: "user-1", spaceId: "space-1" }),
    ).not.toThrow();
    await expect(exporter.flush()).resolves.toBeUndefined();
    expect(client.failures).toBe(1);
  });

  it("gives up on a hanging endpoint instead of holding shutdown", async () => {
    const exporter = new TraceExporter({ send: () => new Promise<void>(() => {}) });
    exporter.export(recordedTrace(), { userId: "user-1", spaceId: "space-1" });
    await expect(exporter.flush(5)).resolves.toBeUndefined();
  });
});
