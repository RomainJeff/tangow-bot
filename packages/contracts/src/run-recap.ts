import { z } from "zod";
import { Id } from "./ids.js";

const EntryId = Id.brand<"EntryId">();

const facts = z.array(z.string().trim().min(1).max(1000)).min(1).max(12).optional();
export const FactualRunRecapFactsSchema = z
  .strictObject({
    version: z.literal(1),
    results: facts,
    decisions: facts,
    limits: facts,
    references: z
      .array(
        z.union([
          z.strictObject({ entryId: EntryId }),
          z.strictObject({ callId: z.string().min(1).max(200) }),
        ]),
      )
      .max(32),
  })
  .refine((value) => value.results || value.decisions || value.limits, "Recap needs facts");

export const FactualRunRecapSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), facts: FactualRunRecapFactsSchema }),
  z.object({
    state: z.literal("missing"),
    reason: z.enum(["absent", "invalid", "invalid_reference", "interrupted"]),
  }),
]);
export type FactualRunRecap = z.infer<typeof FactualRunRecapSchema>;

export function parseRunRecap(text: string | undefined): FactualRunRecap {
  if (!text?.trim()) return { state: "missing", reason: "absent" };
  if (text.length > 24000) return { state: "missing", reason: "invalid" };
  try {
    const parsed = FactualRunRecapFactsSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { state: "available", facts: parsed.data };
  } catch {}
  return { state: "missing", reason: "invalid" };
}
