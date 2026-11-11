import type { MessageBlock, SessionId } from "@tangow/contracts";

export function progressMessageId(runId: string): string {
  return `progress:${runId}`;
}

export function isRunTerminalEvent(event: { type: string }): boolean {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

const RUN_FAILURE_ERROR_MAX = 300;

/** Reason a run failed, clamped for display, or null when there is no usable error to show. */
export function runFailureError(event: {
  type: string;
  payload?: Record<string, unknown>;
}): string | null {
  if (event.type !== "run.failed") return null;
  const error = event.payload?.error;
  if (typeof error !== "string" || !error.trim()) return null;
  const message = error.trim();
  // A provider can fail with a stack or a whole response body; the run record keeps the full
  // text while the UI shows a bounded first line.
  return message.length > RUN_FAILURE_ERROR_MAX
    ? `${message.slice(0, RUN_FAILURE_ERROR_MAX)}…`
    : message;
}

export function reduceLiveMessageBlocks(
  blocks: readonly MessageBlock[],
  payload: Record<string, unknown> | undefined,
): MessageBlock[] {
  const tail = blocks.at(-1);
  const segments = tail?.kind === "progress" ? blocks.slice(0, -1) : blocks;
  const priorText = liveMessageText(blocks);
  const flushedLength =
    tail?.kind === "progress" ? priorText.length - tail.text.length : priorText.length;
  const tailText = progressMessageText(payload, priorText).slice(flushedLength);
  if (!tailText) return [...segments];
  return [
    ...segments,
    {
      kind: "progress",
      text: tailText,
      ...(payload?.activity === true ? { activity: true as const } : {}),
    },
  ];
}

function liveMessageText(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text" || block.kind === "progress")
    .map((block) => block.text)
    .join("");
}

export type ToolCallDetail = {
  name: string;
  input: string;
  output: string;
  id?: string;
  outcome?: true;
  sessionId?: SessionId;
};
export type ToolStep = { label: string; count: number; calls?: ToolCallDetail[] };

export function appendToolStep(
  steps: readonly ToolStep[],
  toolName: string,
  call?: ToolCallDetail,
): ToolStep[] {
  const label = humanizeToolName(toolName);
  const last = steps.at(-1);
  const calls = call ? [call] : undefined;
  if (last && last.label === label) {
    const merged =
      last.calls || calls ? { calls: [...(last.calls ?? []), ...(calls ?? [])] } : undefined;
    return [...steps.slice(0, -1), { label, count: last.count + 1, ...merged }];
  }
  return [...steps, { label, count: 1, ...(calls ? { calls } : {}) }];
}

export type ToolCallStreak = { key: string | undefined; count: number };

export function trackToolCallStreak(
  streak: ToolCallStreak,
  name: string,
  args: unknown,
): ToolCallStreak {
  const key = `${name}:${JSON.stringify(args)}`;
  return key === streak.key ? { key, count: streak.count + 1 } : { key, count: 1 };
}

export type ToolNameStreak = { name: string | undefined; count: number };

export function trackToolNameStreak(streak: ToolNameStreak, name: string): ToolNameStreak {
  return name === streak.name ? { name, count: streak.count + 1 } : { name, count: 1 };
}

const SENTENCE_END_RE = /[.!?]["'”’)\]]*\s*$/;

/** True once `text` ends at a sentence boundary (or is empty) — safe to flush without cutting a clause. */
export function endsSentence(text: string): boolean {
  return text.trim() === "" || SENTENCE_END_RE.test(text);
}

export function appendTextSegment(segments: readonly MessageBlock[], text: string): MessageBlock[] {
  if (!text) return [...segments];
  const last = segments.at(-1);
  if (last?.kind === "text") {
    return [...segments.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...segments, { kind: "text", text }];
}

export function appendToolCallSegment(
  segments: readonly MessageBlock[],
  toolName: string,
  call?: ToolCallDetail,
): MessageBlock[] {
  const last = segments.at(-1);
  const priorSteps = last?.kind === "steps" ? last.steps : [];
  const steps = appendToolStep(priorSteps, toolName, call);
  if (last?.kind === "steps") {
    return [...segments.slice(0, -1), { kind: "steps", steps }];
  }
  return [...segments, { kind: "steps", steps }];
}

export function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  if (!spaced) return name;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function progressMessageText(
  payload: Record<string, unknown> | undefined,
  previousText = "",
): string {
  return typeof payload?.delta === "string"
    ? previousText + payload.delta
    : String(payload?.text ?? "");
}

export function redactSecrets(value: string, secrets: string[]): string {
  return secretRedactor(secrets)(value);
}

/**
 * Only text whose first character past whitespace opens an object, an array or a string can parse
 * to one. Any other text either fails to parse or parses to a scalar, and both are masked as plain
 * text, so it skips the parse and the exception a failed one throws.
 */
const JSON_CONTAINER_START = /^\s*[[{"]/;

/**
 * `redactSecrets` for many strings against the same secrets: the secrets and their JSON-escaped
 * forms are prepared once. Each string still gets its own scan budget.
 */
export function secretRedactor(secrets: string[]): (value: string) => string {
  const active = [...new Set(secrets.filter((secret) => secret.length > 0))];
  if (active.length === 0) return (value) => value;
  const variants = [
    ...new Set(active.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])),
  ];
  return (value) => {
    let remaining = 8 * 1024 * 1024;

    function maskLiterals(text: string): string {
      let ends: Uint32Array | undefined;
      for (const secret of variants) {
        remaining -= text.length;
        if (remaining < 0) return "[redacted]";
        for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
          remaining -= secret.length;
          if (remaining < 0) return "[redacted]";
          ends ??= new Uint32Array(text.length);
          ends[at] = Math.max(ends[at] ?? 0, at + secret.length);
        }
      }
      if (!ends) return text;
      let result = "";
      let copied = 0;
      for (let at = 0; at < text.length; at++) {
        let end = ends[at] ?? 0;
        if (end <= at) continue;
        result += `${text.slice(copied, at)}[redacted]`;
        for (let next = at + 1; next < end; next++) end = Math.max(end, ends[next] ?? 0);
        copied = end;
        at = end - 1;
      }
      return result + text.slice(copied);
    }

    function redactJson(text: string, depth: number): string {
      remaining -= text.length;
      if (remaining < 0 || depth > 32) {
        remaining = -1;
        return "[redacted]";
      }
      if (active.includes(text)) return "[redacted]";
      if (!JSON_CONTAINER_START.test(text)) return maskLiterals(text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return maskLiterals(text);
      }
      if (typeof parsed === "string" || (parsed !== null && typeof parsed === "object")) {
        const safe = text.replace(/"(?:[^"\\]|\\.)*"/g, (token) => {
          const decoded: unknown = JSON.parse(token);
          if (typeof decoded !== "string") return token;
          const redacted = redactJson(decoded, depth + 1);
          return redacted === decoded ? token : JSON.stringify(redacted);
        });
        return maskLiterals(safe);
      }
      return maskLiterals(text);
    }

    const safe = redactJson(value, 0);
    return remaining < 0 ? "[redacted]" : safe;
  };
}

export function containsSecret(value: unknown, secrets: string[]): boolean {
  const active = secrets.filter((secret) => secret.length > 0);
  if (active.length === 0) return false;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return false;
  const pending: unknown[] = [JSON.parse(serialized)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (active.some((secret) => current.includes(secret))) return true;
      continue;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      const primitive = String(current);
      if (active.some((secret) => primitive.includes(secret))) return true;
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(current)) {
        if (active.some((secret) => key.includes(secret))) return true;
        pending.push(nested);
      }
    }
  }
  return false;
}

/** UTF-16 high surrogates (0xD800–0xDBFF) must be paired with a low surrogate for valid JSON. */
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

/**
 * Replace unpaired UTF-16 surrogates so the string is safe for JSON (Postgres rejects them).
 */
export function sanitizeUtf16ForJson(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (isHighSurrogate(code)) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (isLowSurrogate(next)) {
        result += value[i]! + value[i + 1]!;
        i += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (isLowSurrogate(code)) {
      result += "\uFFFD";
    } else {
      result += value[i]!;
    }
  }
  return result;
}

/** Deep-sanitize string leaves so event payloads never carry unpaired surrogates into JSON. */
export function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeUtf16ForJson(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const used = new Map<string, number>();
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      let safeKey = sanitizeUtf16ForJson(key);
      const seen = used.get(safeKey) ?? 0;
      used.set(safeKey, seen + 1);
      // Deterministic collision handling when sanitizing collapses distinct keys.
      if (seen > 0) safeKey = `${safeKey}#${seen + 1}`;
      out[safeKey] = sanitizeJsonValue(nested);
    }
    return out as T;
  }
  return value;
}
