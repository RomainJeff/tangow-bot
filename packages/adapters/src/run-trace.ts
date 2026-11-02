import type {
  AttributeValue,
  RecordedTelemetryLink,
  SpanAttributes,
  SpanLink,
  SpanOptions,
  SpanStatus,
  TelemetryCarrier,
  TelemetryContext,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { generateTraceId } from "@rakazo/logging";

const INERT_TELEMETRY_SPAN: TelemetrySpan = {
  ...NOOP_TELEMETRY_CONTEXT,
  metrics: undefined,
  propagation: undefined,
  async startSpan(_options, callback) {
    return callback(INERT_TELEMETRY_SPAN);
  },
};

/** One recorded point-in-time event attached to a span. */
export interface RecordedSpanEvent {
  readonly name: string;
  readonly attributes: SpanAttributes;
}

/**
 * A span captured by {@link RunTrace}.
 *
 * The shape follows the telemetry contract's in-memory reference adapter so the
 * published conformance suite applies, and adds wall-clock timestamps, which the
 * reference adapter does not keep and an exporter cannot do without.
 */
export interface RecordedSpan {
  /** Trace-local sequence number, matching the telemetry contract's reference adapter. */
  readonly id: number;
  readonly parentId: number | null;
  readonly context: Readonly<TelemetryCarrier>;
  readonly parentContext: Readonly<TelemetryCarrier> | null;
  readonly links: readonly RecordedTelemetryLink[];
  readonly name: string;
  readonly attributes: SpanAttributes;
  readonly events: readonly RecordedSpanEvent[];
  readonly status: SpanStatus;
  readonly settled: boolean;
  readonly endSequence?: number;
  /** Epoch milliseconds when the span opened. */
  readonly startedAt: number;
  /** Epoch milliseconds when the span settled, absent while it is still open. */
  readonly endedAt?: number;
}

/** Outcome handed to {@link RunTraceSpan.end} when a span is closed by hand. */
export interface SpanOutcome {
  readonly ok: boolean;
  readonly error?: unknown;
}

export interface RunTraceOptions {
  /** Injectable clock, so tests produce deterministic durations. */
  now?: () => number;
  /** Trace id shared by every span of the run. Generated when omitted. */
  traceId?: string;
}

function describeError(error: unknown): { name: string; message: string } {
  try {
    if (error instanceof Error) {
      return { name: String(error.name), message: String(error.message) };
    }
  } catch {
    // Reading an exotic thrown value must never break the recorder.
  }
  return { name: "Error", message: "unknown error" };
}

/**
 * Copies attributes, dropping undefined values. Throws when a value cannot be
 * read, which callers turn into "record nothing" rather than a failure.
 */
function normalizeAttributes(input: SpanAttributes | undefined): SpanAttributes {
  if (input === undefined) return {};
  const output: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    output[key] = Array.isArray(value) ? [...value] : value;
  }
  return output;
}

function normalizeStatus(input: SpanStatus): SpanStatus {
  if (input.status === "ok") return { status: "ok" };
  const error = input.error;
  return error === undefined
    ? { status: "error" }
    : { status: "error", error: { name: String(error.name), message: String(error.message) } };
}

class RunTraceSpanImpl implements TelemetrySpan {
  readonly attributes: Record<string, AttributeValue> = {};
  readonly events: RecordedSpanEvent[] = [];
  readonly links: RecordedTelemetryLink[] = [];
  readonly context: Readonly<TelemetryCarrier>;
  status: SpanStatus = { status: "ok" };
  settled = false;
  endSequence?: number;
  endedAt?: number;
  private explicitStatus = false;

  constructor(
    private readonly trace: RunTrace,
    readonly id: number,
    readonly parentId: number | null,
    readonly parentContext: Readonly<TelemetryCarrier> | null,
    readonly name: string,
    attributes: SpanAttributes,
    readonly startedAt: number,
  ) {
    this.context = { traceId: trace.traceId, spanId: String(id) };
    Object.assign(this.attributes, attributes);
  }

  setAttributes(attributes: SpanAttributes): void {
    if (this.settled) return;
    let normalized: SpanAttributes;
    try {
      normalized = normalizeAttributes(attributes);
    } catch {
      return;
    }
    Object.assign(this.attributes, normalized);
  }

  addLink(link: SpanLink): void {
    if (this.settled || !(link.context instanceof RunTraceSpanImpl)) return;
    try {
      this.links.push({
        context: { ...link.context.context },
        attributes: normalizeAttributes(link.attributes),
      });
    } catch {
      return;
    }
  }

  addEvent(name: string, attributes?: SpanAttributes): void {
    if (this.settled) return;
    let event: RecordedSpanEvent;
    try {
      event = { name: String(name), attributes: normalizeAttributes(attributes) };
    } catch {
      return;
    }
    this.events.push(event);
  }

  setStatus(status: SpanStatus): void {
    if (this.settled) return;
    let normalized: SpanStatus;
    try {
      normalized = normalizeStatus(status);
    } catch {
      return;
    }
    this.status = normalized;
    this.explicitStatus = true;
  }

  startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    return this.trace.run(options, callback, this);
  }

  /** Closes a span opened with {@link RunTrace.openSpan}. Inert once settled. */
  end(outcome: SpanOutcome = { ok: true }): void {
    if (this.settled) return;
    if (!this.explicitStatus) {
      this.status = outcome.ok
        ? { status: "ok" }
        : { status: "error", error: describeError(outcome.error) };
    }
    this.settled = true;
    this.endedAt = this.trace.now();
    this.endSequence = this.trace.nextSequence();
  }
}

/** Span handle returned by {@link RunTrace.openSpan}. */
export type RunTraceSpan = RunTraceSpanImpl;

/**
 * Records the spans of a single agent run in memory.
 *
 * Implements the vendor-neutral telemetry contract so it can be handed to pi as
 * a telemetry context, and additionally exposes {@link openSpan} for the
 * event-driven call sites that open and close a span from two different
 * callbacks and cannot wrap their work in `startSpan`.
 */
export class RunTrace implements TelemetryContext {
  readonly traceId: string;
  private readonly spans: RunTraceSpanImpl[] = [];
  private readonly clock: () => number;
  private sequence = 0;
  private spanId = 0;

  constructor(options: RunTraceOptions = {}) {
    this.clock = options.now ?? (() => Date.now());
    this.traceId = options.traceId ?? generateTraceId();
  }

  now(): number {
    return this.clock();
  }

  private nextSpanId(): number {
    this.spanId += 1;
    return this.spanId;
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** Every span recorded so far, in the order they opened. */
  getSpans(): readonly RecordedSpan[] {
    return this.spans;
  }

  startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    return this.run(options, callback, null);
  }

  /**
   * Opens a span the caller closes itself. Returns undefined when the options
   * cannot be read, so telemetry stays passive instead of failing the caller.
   */
  openSpan(options: SpanOptions, parent?: RunTraceSpan): RunTraceSpan | undefined {
    if (parent?.settled === true) return undefined;
    return this.open(options, parent ?? null);
  }

  run<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
    parent: RunTraceSpanImpl | null,
  ): Promise<T> {
    const span = parent?.settled === true ? undefined : this.open(options, parent);
    // A span that could not be recorded still admits its callback exactly once.
    if (!span) return INERT_TELEMETRY_SPAN.startSpan(options, callback);
    let result: T | Promise<T>;
    try {
      result = callback(span);
    } catch (error) {
      span.end({ ok: false, error });
      return Promise.reject(error);
    }
    return Promise.resolve(result).then(
      (value) => {
        span.end({ ok: true });
        return value;
      },
      (error: unknown) => {
        span.end({ ok: false, error });
        throw error;
      },
    );
  }

  private open(
    options: SpanOptions,
    parent: RunTraceSpanImpl | null,
  ): RunTraceSpanImpl | undefined {
    let name: string;
    let attributes: SpanAttributes;
    try {
      name = String(options.name);
      attributes = normalizeAttributes(options.attributes);
    } catch {
      return undefined;
    }
    const span = new RunTraceSpanImpl(
      this,
      this.nextSpanId(),
      parent?.id ?? null,
      parent ? { ...parent.context } : null,
      name,
      attributes,
      this.now(),
    );
    for (const link of options.links ?? []) span.addLink(link);
    this.spans.push(span);
    return span;
  }
}
