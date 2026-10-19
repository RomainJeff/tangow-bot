import * as z from "zod";
import { Id } from "./ids.js";

const safeKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/)
  .refine((key) => !["__proto__", "constructor", "prototype", "none"].includes(key));

export const PreparedMemoryMethodSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            key: safeKey,
            label: z.string().trim().min(1).max(160),
            instructions: z.string().trim().min(1).max(2000),
            options: z
              .array(
                z
                  .object({
                    key: safeKey,
                    label: z.string().trim().min(1).max(120),
                    description: z.string().trim().min(1).max(600),
                  })
                  .strict(),
              )
              .min(1)
              .max(19),
          })
          .strict()
          .superRefine((question, ctx) => {
            if (new Set(question.options.map(({ key }) => key)).size !== question.options.length)
              ctx.addIssue({
                code: "custom",
                message: "Option keys must be unique",
                path: ["options"],
              });
          }),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((method, ctx) => {
    if (new Set(method.questions.map(({ key }) => key)).size !== method.questions.length)
      ctx.addIssue({
        code: "custom",
        message: "Question keys must be unique",
        path: ["questions"],
      });
  });
export type PreparedMemoryMethod = z.infer<typeof PreparedMemoryMethodSchema>;

export const MemoryMethodSnapshotSchema = z.object({
  id: Id,
  botId: Id,
  version: z.number().int().positive(),
  instructions: z.string(),
  prepared: PreparedMemoryMethodSchema,
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime(),
});
export type MemoryMethodSnapshot = z.infer<typeof MemoryMethodSnapshotSchema>;

export const MemoryMethodAnnotationSchema = z.object({
  id: Id,
  bot: z.object({ id: Id, name: z.string() }),
  method: z.object({
    id: Id,
    version: z.number().int().positive(),
    questions: PreparedMemoryMethodSchema.shape.questions,
  }),
  answers: z.record(z.string(), z.string().nullable()),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type MemoryMethodAnnotation = z.infer<typeof MemoryMethodAnnotationSchema>;

export const BotMemoryClassificationSuggestionSchema = z.object({
  answers: z.record(z.string(), z.string().nullable()),
  abstained: z.boolean(),
  abstentionReason: z.string().optional(),
  metadata: z.object({
    provider: z.string(),
    model: z.string(),
    schemaVersion: z.string(),
    confidence: z.number().optional(),
    dimensionConfidence: z.record(z.string(), z.number().min(0).max(1)).optional(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  }),
});
export type BotMemoryClassificationSuggestion = z.infer<
  typeof BotMemoryClassificationSuggestionSchema
>;
