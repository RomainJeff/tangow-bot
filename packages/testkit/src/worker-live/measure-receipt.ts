import { quantiles } from "../worker-channel-tap.js";
import type { MeasuredModel, ThreadRecord, TurnRecord } from "./measure.js";
import { SCENARIOS } from "./measure.js";

type Tokens = { uncached: number; cacheRead: number; cacheWrite: number; output: number };
const zero = (): Tokens => ({ uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const add = (total: Tokens, part: Tokens) => {
  total.uncached += part.uncached;
  total.cacheRead += part.cacheRead;
  total.cacheWrite += part.cacheWrite;
  total.output += part.output;
};

/** List price in US dollars, from the catalog's per-million rates. */
export function priced(tokens: Tokens, cost: MeasuredModel["cost"]) {
  return (
    (tokens.uncached * cost.input +
      tokens.cacheRead * cost.cacheRead +
      tokens.cacheWrite * cost.cacheWrite +
      tokens.output * cost.output) /
    1_000_000
  );
}

/**
 * The measured root requests of one thread, and an estimate of the same work in one persistent
 * native session. That session would continue each attempt from the previous request's full
 * prompt and answer, adding only what the projection's request added past the shared prefix,
 * and grow within an attempt as the projection did. Its estimate is generous: the previous
 * prompt counts as cached whenever the projection's request read any cache, and a compaction
 * restarts it from the projection.
 */
export function persistentEstimate(turns: TurnRecord[], billsWrites: boolean) {
  const projection = zero();
  const persistent = zero();
  let previous: { prompt: number; output: number; attemptId: string } | undefined;
  let extra = 0;
  for (const turn of turns) {
    if (turn.compacted) {
      previous = undefined;
      extra = 0;
    }
    for (const request of turn.requests) {
      if (request.agent !== "root" || !request.usageReported) continue;
      const input = request.inputTokens ?? 0;
      const read = request.cacheReadTokens ?? 0;
      const write = request.cacheWriteTokens ?? 0;
      const output = request.outputTokens ?? 0;
      add(projection, {
        uncached: input - read - write,
        cacheRead: read,
        cacheWrite: write,
        output,
      });
      const warm = read > 0;
      let prompt: number;
      let cached: number;
      if (previous && previous.attemptId !== request.attemptId) {
        const bytes = request.promptBytes ?? 0;
        const added = bytes
          ? Math.round(((bytes - (request.commonPrefixBytes ?? 0)) * input) / bytes)
          : input;
        prompt = previous.prompt + previous.output + added;
        cached = warm ? previous.prompt : 0;
        extra = prompt - input;
      } else {
        prompt = input + extra;
        cached = warm ? read + extra : 0;
      }
      const written = billsWrites ? prompt - cached : 0;
      add(persistent, {
        uncached: prompt - cached - written,
        cacheRead: cached,
        cacheWrite: written,
        output,
      });
      previous = { prompt, output, attemptId: request.attemptId };
    }
  }
  return { projection, persistent };
}

const ratio = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;

/** What the receipt concludes, per model, from the measured threads. */
export function summarize(threads: ThreadRecord[], models: MeasuredModel[]) {
  return Object.fromEntries(
    models.map((model) => {
      const own = threads.filter((thread) => thread.model === model.id);
      const requests = own.flatMap((thread) => thread.turns.flatMap((turn) => turn.requests));
      const reads = requests.some((request) => (request.cacheReadTokens ?? 0) > 0);
      const writes = requests.some((request) => (request.cacheWriteTokens ?? 0) > 0);
      const byScenario = Object.fromEntries(
        SCENARIOS.filter((scenario) => own.some((thread) => thread.scenario === scenario)).map(
          (scenario) => {
            const projection = zero();
            const persistent = zero();
            for (const thread of own.filter((entry) => entry.scenario === scenario)) {
              const estimate = persistentEstimate(thread.turns, writes);
              add(projection, estimate.projection);
              add(persistent, estimate.persistent);
            }
            const projectionUsd = priced(projection, model.cost);
            const persistentUsd = priced(persistent, model.cost);
            return [
              scenario,
              {
                projection,
                persistentEstimate: persistent,
                projectionUsd,
                persistentUsd,
                persistentSaving:
                  projectionUsd > 0 ? ratio(projectionUsd - persistentUsd, projectionUsd) : null,
              },
            ];
          },
        ),
      );
      const totals = Object.values(byScenario).reduce(
        (sum, entry) => ({
          projectionUsd: sum.projectionUsd + entry.projectionUsd,
          persistentUsd: sum.persistentUsd + entry.persistentUsd,
        }),
        { projectionUsd: 0, persistentUsd: 0 },
      );
      const saving = ratio(totals.projectionUsd - totals.persistentUsd, totals.projectionUsd);
      const chainFirstRequests = own
        .filter((thread) => thread.scenario === "chain")
        .flatMap((thread) => thread.turns.slice(1));
      const turns = own.flatMap((thread) => thread.turns);
      // Cache read up to the shared base is reuse across threads; the rest is the thread's own.
      const reuse = { sharedBase: 0, perThread: 0, firstRequestsOverBase: 0, firstRequests: 0 };
      for (const thread of own) {
        const first = thread.turns[0]?.requests[0];
        if (!thread.sharedBase || !first?.inputTokens) continue;
        // A provider may render the tools before the messages, so the shared base is whichever
        // runs longer: the messages before their first per-thread byte, or the tools before the nonce.
        const { sharedChars, bodyChars, nonceAt, toolsAt } = thread.sharedBase;
        const base = Math.round(
          (first.inputTokens *
            Math.max(sharedChars, toolsAt >= 0 && toolsAt < nonceAt ? nonceAt - toolsAt : 0)) /
            bodyChars,
        );
        reuse.firstRequests += 1;
        if ((first.cacheReadTokens ?? 0) > base * 1.1 + 128) reuse.firstRequestsOverBase += 1;
        for (const request of thread.turns.flatMap((turn) => turn.requests)) {
          const read = request.cacheReadTokens ?? 0;
          reuse.sharedBase += Math.min(read, base);
          reuse.perThread += read - Math.min(read, base);
        }
      }
      return [
        model.id,
        {
          cache: {
            mode: own.some((thread) => thread.cacheMarkersSent)
              ? "explicit markers"
              : reads || writes
                ? "automatic"
                : "none observed",
            markersSent: own.some((thread) => thread.cacheMarkersSent === undefined)
              ? "not captured"
              : own.some((thread) => thread.cacheMarkersSent),
            readsReported: reads,
            writesReported: writes,
          },
          requests: requests.length,
          threadErrors: own.filter((thread) => thread.error !== undefined).length,
          requestsWithoutUsage: requests.filter((request) => !request.usageReported).length,
          successRate: ratio(
            turns.filter((turn) => turn.status === "completed").length,
            turns.length,
          ),
          cacheReadShareByGapMs: Object.fromEntries(
            [...new Set(chainFirstRequests.map((turn) => turn.waitMs))]
              .sort((a, b) => a - b)
              .map((gap) => [
                gap,
                quantiles(
                  chainFirstRequests
                    .filter((turn) => turn.waitMs === gap && turn.requests[0])
                    .map((turn) => {
                      const first = turn.requests[0]!;
                      return (first.cacheReadTokens ?? 0) / Math.max(1, first.inputTokens ?? 0);
                    }),
                ),
              ]),
          ),
          cacheReadReuse: reuse.firstRequests > 0 ? reuse : "not captured",
          byScenario,
          projectionUsd: totals.projectionUsd,
          persistentUsd: totals.persistentUsd,
          persistentSaving: saving,
          buildPersistentArm: saving !== null && saving >= 0.15,
          restoreByGrantDelayMs: Object.fromEntries(
            [...new Set(turns.flatMap((turn) => turn.approveAfterMs ?? []))].map((delay) => {
              const granted = turns.filter((turn) => turn.approveAfterMs === delay);
              const measured = (key: "restoreOutsideProvisioningMs" | "provisioningMs") =>
                quantiles(
                  granted.flatMap((turn) =>
                    typeof turn[key] === "number" ? [turn[key] as number] : [],
                  ),
                );
              return [
                delay,
                {
                  outsideProvisioningMs: measured("restoreOutsideProvisioningMs"),
                  provisioningMs: measured("provisioningMs"),
                },
              ];
            }),
          ),
          transcriptAppendMs: quantiles(turns.flatMap((turn) => turn.appends.map((a) => a.ms))),
          transcriptAppendQueries: quantiles(
            turns.flatMap((turn) => turn.appends.map((a) => a.queries)),
          ),
        },
      ];
    }),
  );
}

/** E2B names sandboxes, templates, builds and volumes with 20 lowercase letters and digits. */
const E2B_ID = /\b[a-z0-9]{20}\b/g;

/**
 * The receipt as written. Infrastructure identifiers never leave the runner: each private one
 * passed in becomes its label, and any other E2B identifier becomes `<e2b-id>`.
 */
export function measureReceipt(
  fields: Record<string, unknown>,
  threads: ThreadRecord[],
  models: MeasuredModel[],
  labels: Record<string, string>,
): unknown {
  let text = JSON.stringify({
    ...fields,
    method: METHOD,
    summary: summarize(threads, models),
    threads,
  });
  for (const [id, label] of Object.entries(labels)) text = text.replaceAll(id, label);
  return JSON.parse(text.replace(E2B_ID, "<e2b-id>"));
}

/** How every figure of the receipt is derived from its `threads`, so it can be recomputed. */
const METHOD = {
  source:
    "One record per model request, from agent.worker.model_request at the controller relay, grouped by thread, turn and attempt.",
  inputTokens:
    "Every prompt token the provider reported, cached or not. Uncached = inputTokens - cacheReadTokens - cacheWriteTokens.",
  promptBytes:
    "UTF-8 bytes of the redacted canonical transcript the relay received (pi-ai-transcript-v1), not provider wire bytes. commonPrefixBytes is the part shared with the previous request of the same thread and bot.",
  pricing:
    "Catalog list price per million tokens (models[].catalogCostPerMillion: input, cacheRead, cacheWrite, output), without long-context tiers. USD = (uncached * input + cacheRead * cacheRead + cacheWrite * cacheWrite + output * output) / 1e6.",
  persistentEstimate:
    "Replays each thread's root requests with usage, in order; helper requests are left out of both arms. Within an attempt the persistent prompt is the projection's inputTokens plus a carried extra. At the first request of a new attempt it is the previous request's prompt + its outputTokens + the tokens this request added past the shared prefix, round((promptBytes - commonPrefixBytes) * inputTokens / promptBytes); extra becomes that prompt minus inputTokens. Cached: if the projection's request read any cache, the whole previous prompt at an attempt start, or the projection's read + extra within an attempt; otherwise none. Written: prompt - cached when the model reported any cache write, else 0. A compacted turn restarts the estimate from the projection. Screenshots and images of earlier turns stay in the carried prompt as far as they were still in the previous request after the relay's image cap, which a persistent session behind the same relay would also hit; they are never dropped at a run boundary. The estimate is generous to the persistent session: its whole previous prompt counts as cached whenever the projection read any cache. persistentSaving = (projectionUsd - persistentUsd) / projectionUsd; buildPersistentArm when it is 0.15 or more.",
  cache:
    "mode is explicit markers when a thread's first provider request carried cache_control, automatic when the provider reported cache reads or writes without markers, none observed otherwise. markersSent is read from the captured request bodies.",
  cacheReadReuse:
    "Each thread's first provider request body is compared with the model's earlier threads; sharedChars is the longest common prefix, before any per-thread byte, and the tool catalog from toolsAt up to the nonce at nonceAt is also identical across threads. A provider may render tools before messages, so the shared base is max(sharedChars, nonceAt - toolsAt) characters, converted to tokens as inputTokens of the thread's first request * chars / bodyChars. Of each request's cache read, up to that base counts as sharedBase reuse and the rest as perThread. firstRequestsOverBase counts first requests that read more than that base (+10% and 128 tokens), which would mean reading another thread's own part.",
  restore:
    "From the grant persisted (answerRunInput returned) to the resumed attempt's first model request frame at the controller, minus provisioningMs, the worker provider's ensure call to the guest's hello. Only comparable from a serial run.",
  transcriptAppend:
    "Controller time and database queries from each native transcript frame to its recorded reply. Only comparable from a serial run.",
};
