import { z } from "zod";

// A complete snapshot fits beside bounded receipts in the existing 8 MiB start frame.
export const RUN_SNAPSHOT_BYTES = 3 * 1024 * 1024;
export const RUN_RECEIPTS_BYTES = 3 * 1024 * 1024;
export const RunSnapshotSchema = z.strictObject({
  version: z.literal(1),
  harness: z.strictObject({ name: z.string().min(1), format: z.string().min(1) }),
  revision: z.number().int().nonnegative(),
  state: z.string(),
  deliveredEvents: z.array(z.string()).default([]),
  pendingCallIds: z.array(z.string()).default([]),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export const RunReceiptSchema = z.strictObject({
  callId: z.string().min(1),
  effectId: z.string().min(1).optional(),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("paused"), output: z.unknown() }),
    z.strictObject({ kind: z.literal("result"), output: z.unknown(), isError: z.boolean() }),
  ]),
});
export type RunReceipt = z.infer<typeof RunReceiptSchema>;
export const RunStartSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("fresh") }),
  z.strictObject({ mode: z.literal("legacy") }),
  z.strictObject({
    mode: z.literal("resume"),
    snapshot: RunSnapshotSchema,
    receipts: z.array(RunReceiptSchema),
  }),
]);
export type RunStart = z.infer<typeof RunStartSchema>;
export class RunResumeError extends Error {}

export interface RunPersistence {
  start: RunStart;
  /** Consumes the saved pause only once the worker is ready to execute. */
  begin(): Promise<void>;
  save(snapshot: RunSnapshot): Promise<void>;
  /** Buffers a call outcome until the next pause save. */
  receipt(receipt: RunReceipt): Promise<void>;
  /** Called only after the adapter has validated and restored its native state. */
  resolve(): Promise<RunReceipt[]>;
}

export const RunResumeEventSchema = z.strictObject({ id: z.string(), text: z.string() });
export type RunResumeEvent = z.infer<typeof RunResumeEventSchema>;
