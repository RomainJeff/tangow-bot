import type { ThreadItem } from "@rakazo/contracts";
import { sessionOriginOf } from "@rakazo/core";
import { t } from "./i18n";

export function isViewedRunLine(item: ThreadItem, viewedRunId: string | undefined): boolean {
  return item.kind === "routine" && item.runId === viewedRunId;
}

/** The routine or helper session an item rose from, as the label that opens it. */
export function originSession(item: ThreadItem): { sessionId: string; title: string } | null {
  const origin = sessionOriginOf(item);
  if (!origin) return null;
  return {
    sessionId: origin.sessionId,
    title: origin.name ?? (origin.kind === "routine" ? t("Routine") : t("subagent")),
  };
}
