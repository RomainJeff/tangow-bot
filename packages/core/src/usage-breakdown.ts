import type { UsageCategory, UsageCell } from "@rakazo/contracts";

export type UsageDimension = "bots" | "models" | "categories";
export const USAGE_DIMENSIONS: readonly UsageDimension[] = ["bots", "models", "categories"];

/** A category row: the recorded one, or usage from before categories were recorded. */
export type UsageCategoryKey = UsageCategory | "unrecorded";

/** Spend over a set of cells. Input and output stay apart everywhere. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** The calls made inside a run: the only ones a per-run average divides. */
  runs: { count: number; inputTokens: number; outputTokens: number };
  /** History compaction, counted per pass. */
  compactions: { count: number; inputTokens: number; outputTokens: number };
}

export interface UsageRow extends UsageTotals {
  key: string;
  bot: UsageCell["bot"];
  model: string;
  category: UsageCategoryKey;
}

export interface UsageFocus {
  dimension: UsageDimension;
  key: string;
}

export interface UsageAverage {
  per: "run" | "compaction";
  count: number;
  inputTokens: number;
  outputTokens: number;
}

function keyOf(cell: UsageCell, dimension: UsageDimension): string {
  if (dimension === "bots") return cell.bot?.id ?? "";
  if (dimension === "models") return `${cell.provider}/${cell.model}`;
  return cell.category ?? "unrecorded";
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    runs: { count: 0, inputTokens: 0, outputTokens: 0 },
    compactions: { count: 0, inputTokens: 0, outputTokens: 0 },
  };
}

function add(totals: UsageTotals, cell: UsageCell): void {
  totals.inputTokens += cell.inputTokens;
  totals.outputTokens += cell.outputTokens;
  if (cell.hasRun) {
    totals.runs.count += cell.runs;
    totals.runs.inputTokens += cell.inputTokens;
    totals.runs.outputTokens += cell.outputTokens;
  }
  if (cell.compactions > 0) {
    totals.compactions.count += cell.compactions;
    totals.compactions.inputTokens += cell.inputTokens;
    totals.compactions.outputTokens += cell.outputTokens;
  }
}

/** The tabs a view offers: all of them, or all but the one it is focused on. */
export function usageDimensions(focus?: UsageFocus | null): UsageDimension[] {
  return USAGE_DIMENSIONS.filter((dimension) => dimension !== focus?.dimension);
}

/**
 * One view of the usage screen: the totals of the cells in focus, and one row per bot, model or
 * category, the heaviest first.
 */
export function pivotUsage(
  cells: readonly UsageCell[],
  dimension: UsageDimension,
  focus?: UsageFocus | null,
): { totals: UsageTotals; rows: UsageRow[] } {
  const totals = emptyTotals();
  const rows = new Map<string, UsageRow>();
  for (const cell of cells) {
    if (focus && keyOf(cell, focus.dimension) !== focus.key) continue;
    add(totals, cell);
    const key = keyOf(cell, dimension);
    let row = rows.get(key);
    if (!row) {
      row = {
        ...emptyTotals(),
        key,
        bot: cell.bot,
        model: cell.model,
        category: cell.category ?? "unrecorded",
      };
      rows.set(key, row);
    }
    add(row, cell);
  }
  const weight = (row: UsageTotals) => row.inputTokens + row.outputTokens;
  return { totals, rows: [...rows.values()].sort((a, b) => weight(b) - weight(a)) };
}

/** What a row is averaged over: its runs, else its compactions, else nothing. */
export function usageAverage(totals: UsageTotals): UsageAverage | null {
  const basis = totals.runs.count > 0 ? "run" : totals.compactions.count > 0 ? "compaction" : null;
  if (!basis) return null;
  const part = basis === "run" ? totals.runs : totals.compactions;
  return {
    per: basis,
    count: part.count,
    inputTokens: part.inputTokens / part.count,
    outputTokens: part.outputTokens / part.count,
  };
}

/** `9.8M`, `41K`: a token count at a glance, three digits at most. */
export function formatTokenCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumSignificantDigits: 3 }).format(
    Math.round(value),
  );
}
