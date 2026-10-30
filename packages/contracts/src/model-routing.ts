import * as z from "zod";
import { ThinkingLevelSchema } from "./ids.js";

export const ModelCategorySchema = z.enum(["fast", "everyday", "complex"]);
export type ModelCategory = z.infer<typeof ModelCategorySchema>;

export const ModelCategoryAssignmentSchema = z.object({
  category: ModelCategorySchema,
  provider: z.string(),
  modelId: z.string(),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
});
export type ModelCategoryAssignment = z.infer<typeof ModelCategoryAssignmentSchema>;

export const RunModelDecisionSchema = z.object({
  mode: z.enum(["fixed", "auto", "category"]),
  requestedCategory: ModelCategorySchema.optional(),
  category: ModelCategorySchema.optional(),
  provider: z.string(),
  modelId: z.string(),
  thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  fallback: z
    .enum([
      "no_decision_provider",
      "decision_failed",
      "category_unassigned",
      "capability_mismatch",
      "legacy_call",
    ])
    .optional(),
});
export type RunModelDecision = z.infer<typeof RunModelDecisionSchema>;
