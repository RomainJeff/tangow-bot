import { t } from "@lingui/core/macro";
import type { WorkReturn } from "../../lib/work-return";

/** The glyph, tone and label an outcome shows, wherever a specialist's return is drawn. */
export function outcomeMark(outcome: WorkReturn["outcome"]) {
  if (outcome === "result") return { glyph: "✓", tone: "text-success", label: t`Done` };
  if (outcome === "failed") return { glyph: "✕", tone: "text-destructive", label: t`Failed` };
  if (outcome === "cancelled")
    return { glyph: "⊘", tone: "text-muted-foreground", label: t`Cancelled` };
  if (outcome === "no_result")
    return { glyph: "–", tone: "text-muted-foreground", label: t`No result` };
  return null;
}
