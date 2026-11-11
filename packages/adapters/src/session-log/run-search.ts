import { createHash } from "node:crypto";
import type { RunSearchInput } from "@tangow/adapter-kit";
import type {
  RunSearchHit,
  RunSearchLimitation,
  RunSearchPage,
  SessionEntry,
} from "@tangow/contracts";
import { EntryId } from "@tangow/contracts";
import { matchesSearchQuery, snippetAroundMatch } from "@tangow/core";
import { z } from "zod";

export const RUN_SEARCH_RECORD_BYTES = 1024 * 1024;
export const RUN_SEARCH_CHAIN_ENTRIES = 20_000;
export const RUN_SEARCH_SCAN_ENTRIES = 256;
export const RUN_SEARCH_BATCH_ENTRIES = 8;
export const RUN_SEARCH_MAX_BYTES = 4000;
export const RUN_SEARCH_EXCERPT_CHARS = 160;
const Cursor = z.object({
  binding: z.string(),
  head: z.object({ id: EntryId, seq: z.number().int().nonnegative() }).nullable(),
  cut: z.number().int(),
  after: z.number().int().min(-1),
});
export type RunSearchCursor = z.infer<typeof Cursor>;

export function searchBinding(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function encodeSearchCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeSearchCursor(value: string): unknown {
  if (value.length > 2048) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function openRunSearch(
  input: RunSearchInput,
  current: Pick<RunSearchCursor, "head" | "cut">,
): RunSearchCursor | Extract<RunSearchPage, { status: "unavailable" }> {
  if (!Number.isInteger(input.maxBytes ?? 4000) || (input.maxBytes ?? 4000) < 128)
    throw new RangeError("maxBytes must be at least 128");
  const binding = searchBinding({ scope: input.scope, query: input.query.trim().toLowerCase() });
  if (!input.cursor) return { binding, ...current, after: -1 };
  const parsed = Cursor.safeParse(decodeSearchCursor(input.cursor));
  if (
    !parsed.success ||
    parsed.data.binding !== binding ||
    parsed.data.after > (parsed.data.head?.seq ?? -1)
  ) {
    return { status: "unavailable", reason: "invalid_cursor" };
  }
  if (parsed.data.cut !== current.cut) return { status: "unavailable", reason: "stale_cursor" };
  return parsed.data;
}

export function searchText(entry: SessionEntry): string | undefined {
  switch (entry.type) {
    case "assistant.text":
      return entry.payload.blocks
        .flatMap((block) => (block.kind === "text" ? [block.text] : []))
        .join("\n");
    case "tool.result":
      return entry.payload.output;
    case "subagent":
      return entry.payload.result;
    case "routine.finished":
      return entry.payload.result;
    default:
      return undefined;
  }
}

export function searchExcerpt(input: RunSearchInput, text: string): string | undefined {
  const safe = input.redaction.redact(text);
  if (!matchesSearchQuery(input.query, safe)) return undefined;
  return input.redaction.redact(snippetAroundMatch(safe, input.query, RUN_SEARCH_EXCERPT_CHARS));
}

export function boundedSearchPage(
  input: RunSearchInput,
  cursor: RunSearchCursor,
  candidates: Array<{ seq: number; hit?: RunSearchHit }>,
  more: boolean,
  limitations: RunSearchLimitation[],
): RunSearchPage {
  const budget = Math.min(RUN_SEARCH_MAX_BYTES, input.maxBytes ?? RUN_SEARCH_MAX_BYTES);
  const page: Extract<RunSearchPage, { status: "ok" }> = {
    status: "ok",
    hits: [],
    nextCursor: null,
    incomplete: limitations.length > 0,
    limitations: [...new Set(limitations)],
  };
  let after = cursor.after;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const next = encodeSearchCursor({ ...cursor, after: candidate.seq });
    if (candidate.hit) {
      const proposed = {
        ...page,
        hits: [...page.hits, candidate.hit],
        nextCursor: next,
        incomplete: true,
      };
      if (page.hits.length === 10 || Buffer.byteLength(JSON.stringify(proposed)) > budget) {
        if (page.hits.length === 0) return { status: "unavailable", reason: "budget_too_small" };
        more = true;
        break;
      }
      page.hits.push(candidate.hit);
    }
    after = candidate.seq;
  }
  page.nextCursor = more ? encodeSearchCursor({ ...cursor, after }) : null;
  page.incomplete ||= more;
  if ((page.nextCursor?.length ?? 0) > 2048 || Buffer.byteLength(JSON.stringify(page)) > budget)
    return { status: "unavailable", reason: "budget_too_small" };
  return page;
}

const SessionPhases = z.object({
  kind: z.literal("sessions"),
  binding: z.string(),
  phase: z.number().int().min(0).max(1),
  cursors: z.tuple([z.string().max(2048), z.string().max(2048)]),
});

export async function searchRunSessions(
  input: RunSearchInput,
  state: (
    id: RunSearchInput["scope"]["sessionId"],
  ) => Promise<Pick<RunSearchCursor, "head" | "cut">>,
  search: (input: RunSearchInput) => Promise<RunSearchPage>,
): Promise<RunSearchPage> {
  const { raisedSessionId, ...primary } = input.scope;
  if (!raisedSessionId || raisedSessionId === primary.sessionId) return search(input);
  const scopes = [primary, { ...primary, sessionId: raisedSessionId }];
  const binding = searchBinding({ scope: input.scope, query: input.query.trim().toLowerCase() });
  let phases: z.infer<typeof SessionPhases>;
  if (input.cursor) {
    const decoded = SessionPhases.safeParse(decodeSearchCursor(input.cursor));
    if (!decoded.success || decoded.data.binding !== binding)
      return { status: "unavailable", reason: "invalid_cursor" };
    phases = decoded.data;
  } else {
    const cursors: string[] = [];
    for (const scope of scopes) {
      const opened = openRunSearch({ ...input, scope }, await state(scope.sessionId));
      if ("status" in opened) return opened;
      cursors.push(encodeSearchCursor(opened));
    }
    phases = SessionPhases.parse({ kind: "sessions", binding, phase: 0, cursors });
  }
  const scope = scopes[phases.phase]!;
  const budget = Math.min(RUN_SEARCH_MAX_BYTES, input.maxBytes ?? RUN_SEARCH_MAX_BYTES);
  const reserve = Buffer.byteLength(encodeSearchCursor(phases)) + 128;
  if (budget - reserve < 128) return { status: "unavailable", reason: "budget_too_small" };
  const page = await search({
    ...input,
    scope,
    cursor: phases.cursors[phases.phase],
    maxBytes: budget - reserve,
  });
  if (page.status !== "ok") return page;
  if (page.nextCursor) phases.cursors[phases.phase] = page.nextCursor;
  else phases.phase++;
  const nextCursor = phases.phase < scopes.length ? encodeSearchCursor(phases) : null;
  const result = { ...page, nextCursor, incomplete: page.incomplete || nextCursor !== null };
  if ((nextCursor?.length ?? 0) > 2048 || Buffer.byteLength(JSON.stringify(result)) > budget)
    return { status: "unavailable", reason: "budget_too_small" };
  return result;
}
