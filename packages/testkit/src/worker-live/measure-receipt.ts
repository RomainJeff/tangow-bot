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
      return [
        model.id,
        {
          observedCacheMode: writes ? "explicit" : reads ? "automatic" : "none observed",
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
          byScenario,
          projectionUsd: totals.projectionUsd,
          persistentUsd: totals.persistentUsd,
          persistentSaving: saving,
          buildPersistentArm: saving !== null && saving >= 0.15,
          restoreOutsideProvisioningMs: Object.fromEntries(
            [...new Set(turns.flatMap((turn) => turn.approveAfterMs ?? []))].map((delay) => [
              delay,
              quantiles(
                turns.flatMap((turn) =>
                  turn.approveAfterMs === delay &&
                  typeof turn.restoreOutsideProvisioningMs === "number"
                    ? [turn.restoreOutsideProvisioningMs]
                    : [],
                ),
              ),
            ]),
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
