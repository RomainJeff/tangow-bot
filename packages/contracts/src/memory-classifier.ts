import * as z from "zod";

export const MemoryClassifierConnectionInputSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  apiKey: z.string().trim().min(1).max(4096),
});
export type MemoryClassifierConnectionInput = z.infer<typeof MemoryClassifierConnectionInputSchema>;

export const MemoryClassifierSettingsSchema = z.object({
  spaceName: z.string(),
  canConfigure: z.boolean(),
  providers: z.array(z.object({ id: z.string(), name: z.string(), defaultModel: z.string() })),
  connection: z.object({ provider: z.string(), model: z.string() }).nullable(),
});
export type MemoryClassifierSettings = z.infer<typeof MemoryClassifierSettingsSchema>;
