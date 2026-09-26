import * as z from "zod";
import { MemoryCollectionKindSchema, MemoryQualificationSchema } from "./domain.js";
import { Id } from "./ids.js";

export const MemoryMethodProviderSchema = z.string().trim().min(1).max(80);
export const MemoryMethodModelSchema = z.string().trim().min(1).max(120);
export const MemoryMethodCollectionSchema = MemoryCollectionKindSchema;
export const MemoryMethodSharingSchema = z.enum(["private", "space"]);
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
  provider: MemoryMethodProviderSchema,
  model: MemoryMethodModelSchema,
  allowedCollections: z.array(MemoryMethodCollectionSchema).min(1),
  sharing: MemoryMethodSharingSchema,
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
  sharedWithTeam: z.boolean(),
  revokedAt: z.string().datetime().nullable(),
  isOwn: z.boolean(),
});
export type MemoryMethodAnnotation = z.infer<typeof MemoryMethodAnnotationSchema>;

export const MemoryMethodSettingsSchema = z.object({
  method: MemoryMethodSnapshotSchema.nullable(),
  currentVersion: z.number().int().positive().nullable(),
  canConfigure: z.boolean(),
});
export type MemoryMethodSettings = z.infer<typeof MemoryMethodSettingsSchema>;

export const BotMemoryMethodListEntrySchema = z.object({
  bot: z.object({ id: Id, name: z.string() }),
  method: MemoryMethodSnapshotSchema,
  isOwn: z.boolean(),
});
export type BotMemoryMethodListEntry = z.infer<typeof BotMemoryMethodListEntrySchema>;

export const BotMemoryClassificationResultSchema = z.object({
  candidate: z.object({
    id: Id,
    revision: z.number().int().positive(),
    content: z.string(),
    qualification: MemoryQualificationSchema,
  }),
  neighbors: z
    .array(
      z.object({
        id: Id,
        revision: z.number().int().positive(),
        content: z.string(),
        qualification: MemoryQualificationSchema,
      }),
    )
    .max(8),
  bot: z.object({ id: Id, name: z.string() }),
  method: MemoryMethodSnapshotSchema,
  suggestion: z.object({
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
  }),
  classificationId: Id,
});
export type BotMemoryClassificationResult = z.infer<typeof BotMemoryClassificationResultSchema>;

export const MemoryMethodUpdateInputSchema = z.object({
  botId: Id,
  expectedVersion: z.number().int().positive().nullable(),
  instructions: z.string().trim().min(1).max(20_000),
  provider: MemoryMethodProviderSchema,
  model: z.string().trim().min(1).max(120),
  allowedCollections: z
    .array(MemoryMethodCollectionSchema)
    .min(1)
    .max(3)
    .refine((v) => new Set(v).size === v.length),
  sharing: MemoryMethodSharingSchema.default("private"),
});
export type MemoryMethodUpdateInput = z.infer<typeof MemoryMethodUpdateInputSchema>;
