import type { SkillSourceBlock } from "@rakazo/core";
import { ACTIVE_RUN_STATUSES, plainText } from "@rakazo/core";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];

export const activeRunSelection = {
  where: { status: { in: activeRunStatuses } },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

const SKILL_LINE_PREVIEW = {
  learned: "Skill learned",
  updated: "Skill updated",
  deleted: "Skill deleted",
} as const;

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  let skillLine: SkillSourceBlock | undefined;
  for (const block of rows) {
    // A message the server wrote to carry skill lines alone previews as its first line.
    if (
      block &&
      typeof block === "object" &&
      (block as { kind?: unknown }).kind === "skill_source"
    ) {
      skillLine ??= block as SkillSourceBlock;
      continue;
    }
    // Legacy reasoning blocks carry text but are not part of the answer.
    if (block && typeof block === "object" && (block as { kind?: unknown }).kind === "reasoning") {
      continue;
    }
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      // A block made only of syntax (`---`, `[](url)`) says nothing: look further.
      const text = plainText((block as { text: string }).text);
      if (text) return text;
    }
  }
  return skillLine ? `${SKILL_LINE_PREVIEW[skillLine.change]} · ${skillLine.name}` : "";
}
