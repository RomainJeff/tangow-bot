/**
 * Optional agent trace export.
 *
 * Two shapes were possible. A compatibility object around the published pi
 * observability plugin would have inherited its mapping for free, but that
 * plugin targets the pi CLI extension API, which this product does not use: it
 * would have meant adopting the CLI, a vendor SDK and an OpenTelemetry SDK for
 * a feature that must stay off by default. The home-grown adapter here writes
 * to the telemetry contract already in the dependency graph and speaks OTLP
 * over plain HTTP, so an unconfigured deployment loads no vendor code at all
 * and any OTLP backend can be pointed at instead.
 */
import type { AttributeValue } from "@earendil-works/pi-telemetry";
import { guardedWrite, reportSinkError } from "@rakazo/logging";
import { request } from "undici";

import type { RecordedSpan, RunTrace } from "./run-trace.js";

const TRACE_PATH = "/api/public/otel/v1/traces";
const SCOPE_NAME = "rakazo";

/** Credentials and endpoint of the trace export destination. */
export interface TraceExportConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  environment?: string;
}

/** Transport seam, so tests exercise the exporter without a network. */
export interface TraceExportClient {
  send(payload: unknown): Promise<void>;
}

export interface TraceExportContext {
  userId?: string;
  spaceId?: string;
  serviceName?: string;
  /** Applied to every exported string, so run secrets never leave the process. */
  redact?: (text: string) => string;
}

export function resolveTraceExportConfig(source: NodeJS.ProcessEnv = process.env): {
  config?: TraceExportConfig;
  warning?: string;
} {
  const publicKey = source.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = source.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = source.LANGFUSE_BASE_URL?.trim();
  const environment = source.LANGFUSE_ENVIRONMENT?.trim() || undefined;
  if (!publicKey || !secretKey) {
    if (publicKey || secretKey || baseUrl || environment) {
      return {
        warning:
          "Trace export is disabled; LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must both be set.",
      };
    }
    return {};
  }
  const resolved = resolveTraceEndpoint(baseUrl);
  if (resolved.warning) return { warning: resolved.warning };
  return {
    config: {
      baseUrl: resolved.baseUrl ?? "https://cloud.langfuse.com",
      publicKey,
      secretKey,
      environment,
    },
  };
}

function resolveTraceEndpoint(baseUrl?: string): { baseUrl?: string; warning?: string } {
  if (!baseUrl) return {};
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { warning: "Trace export is disabled; LANGFUSE_BASE_URL is not a valid URL." };
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { warning: "Trace export is disabled; LANGFUSE_BASE_URL must use https." };
  }
  if (url.username || url.password) {
    return { warning: "Trace export is disabled; LANGFUSE_BASE_URL must not include credentials." };
  }
  return { baseUrl: url.toString().replace(/\/+$/, "") };
}

export function createTraceExportClient(config: TraceExportConfig): TraceExportClient {
  const endpoint = `${config.baseUrl}${TRACE_PATH}`;
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`;
  return {
    async send(payload) {
      const response = await request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(payload),
      });
      response.body.dump().catch(() => {});
      if (response.statusCode >= 400) {
        throw new Error(`Trace export rejected with status ${response.statusCode}`);
      }
    },
  };
}

/**
 * Exports recorded run traces to an OTLP endpoint, best effort.
 *
 * Every failure is swallowed through the shared sink guard: a third-party
 * outage degrades observability, never a run. Flushing is bounded so shutdown
 * is never held up by an unreachable endpoint.
 */
export class TraceExporter {
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly client: TraceExportClient,
    private readonly environment?: string,
  ) {}

  export(trace: RunTrace, context: TraceExportContext): void {
    guardedWrite(() => {
      const payload = encodeTrace(trace, {
        environment: this.environment,
        serviceName: context.serviceName,
        redact: context.redact,
      });
      if (!payload) return;
      // Nothing downstream awaits this, so the chain swallows its own failure:
      // an unreachable endpoint must not surface as an unhandled rejection.
      const pending: Promise<void> = this.client
        .send(payload)
        .catch(reportSinkError)
        .finally(() => {
          this.inflight.delete(pending);
        });
      this.inflight.add(pending);
      return pending;
    });
  }

  /** Waits for in-flight exports, giving up after `timeoutMs`. */
  async flush(timeoutMs = 2_000): Promise<void> {
    const pending = [...this.inflight];
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref();
      }),
    ]);
  }
}

/**
 * Builds the exporter a composition root installs, or nothing.
 *
 * Returns `{}` when the deployment configured no endpoint, so an unconfigured
 * process never opens a connection and never pays for the feature.
 * A partial configuration returns a warning to log once.
 *
 * Configuring an endpoint is the whole decision: every run of every user on the
 * deployment is then exported, with no per-user opt-out. An operator who points
 * this at a third party is disclosing their users' conversations to it.
 */
export function createTraceExporterFromEnv(
  source: NodeJS.ProcessEnv = process.env,
  client?: TraceExportClient,
): { exporter?: TraceExporter; baseUrl?: string; warning?: string } {
  const { config, warning } = resolveTraceExportConfig(source);
  if (!config) return warning ? { warning } : {};
  return {
    baseUrl: config.baseUrl,
    exporter: new TraceExporter(client ?? createTraceExportClient(config), config.environment),
  };
}

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

function otlpValue(value: AttributeValue, redact?: (text: string) => string): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: redact ? redact(value) : value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { arrayValue: { values: value.map((item) => otlpValue(item, redact)) } };
}

function otlpAttributes(
  attributes: Record<string, AttributeValue | undefined>,
  redact?: (text: string) => string,
): OtlpKeyValue[] {
  const output: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    output.push({ key, value: otlpValue(value, redact) });
  }
  return output;
}

/** OTLP span ids are 8 bytes; trace-local sequence numbers fill them uniquely. */
function otlpSpanId(id: number): string {
  return id.toString(16).padStart(16, "0");
}

function unixNano(milliseconds: number): string {
  return `${Math.round(milliseconds)}000000`;
}

function otlpStatus(span: RecordedSpan): { code: number; message?: string } {
  if (span.status.status === "ok") return { code: 1 };
  const message = span.status.error
    ? `${span.status.error.name}: ${span.status.error.message}`
    : undefined;
  return message ? { code: 2, message } : { code: 2 };
}

/**
 * Turns a recorded run trace into an OTLP/HTTP JSON request body, or undefined
 * when the run produced nothing worth sending.
 */
export function encodeTrace(
  trace: RunTrace,
  options: {
    environment?: string;
    serviceName?: string;
    redact?: (text: string) => string;
  } = {},
): unknown {
  const spans = trace.getSpans().filter((span) => span.settled);
  if (spans.length === 0) return undefined;
  // Span events carry no Langfuse meaning; only attributes and timing are sent.
  return {
    resourceSpans: [
      {
        resource: {
          attributes: otlpAttributes({
            "service.name": options.serviceName ?? SCOPE_NAME,
            ...(options.environment ? { "deployment.environment.name": options.environment } : {}),
          }),
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: spans.map((span) => ({
              traceId: trace.traceId,
              spanId: otlpSpanId(span.id),
              ...(span.parentId === null ? {} : { parentSpanId: otlpSpanId(span.parentId) }),
              name: span.name,
              kind: 1,
              startTimeUnixNano: unixNano(span.startedAt),
              endTimeUnixNano: unixNano(span.endedAt ?? span.startedAt),
              attributes: otlpAttributes(
                {
                  ...span.attributes,
                  ...(options.environment ? { "langfuse.environment": options.environment } : {}),
                },
                options.redact,
              ),
              status: otlpStatus(span),
            })),
          },
        ],
      },
    ],
  };
}
