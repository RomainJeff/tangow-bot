import { isDeepStrictEqual } from "node:util";
import type { RunPersistence, RunReceipt, RunSnapshot } from "@rakazo/adapter-kit";
import {
  RUN_RECEIPTS_BYTES,
  RUN_SNAPSHOT_BYTES,
  RunReceiptSchema,
  RunSnapshotSchema,
} from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import { z } from "zod";
import type { PrismaClient } from "./client.js";

const Row = z.strictObject({
  sessionId: z.string(),
  snapshot: RunSnapshotSchema,
  receipts: z.array(RunReceiptSchema),
});

/** The run row lock serializes snapshots and receipts with lease changes and cancellation. */
export async function runPersistence(
  prisma: PrismaClient,
  runId: string,
  fence: number,
  secrets: readonly string[],
  legacy: boolean,
): Promise<RunPersistence> {
  const mask = (value: unknown) => JSON.parse(redactSecrets(JSON.stringify(value), [...secrets]));
  const read = async () => {
    const rows = await prisma.$queryRaw<
      unknown[]
    >`SELECT "sessionId", snapshot, receipts FROM run_snapshots WHERE "runId" = ${runId}`;
    return rows.length ? Row.parse(mask(rows[0])) : undefined;
  };
  const previous = await read();
  const marker = await prisma.$queryRaw<
    { resumeRequired: boolean }[]
  >`SELECT "resumeRequired" FROM runs WHERE id = ${runId}`;
  if (marker[0]?.resumeRequired && !previous)
    throw new Error("Required resume snapshot is missing");
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    select: { sessionId: true, thread: { select: { sessionId: true } } },
  });
  if (previous && previous.sessionId !== run.sessionId)
    throw new Error("Resume state belongs to a different session");
  const mutate = async (
    update: (state: z.infer<typeof Row> | undefined) => z.infer<typeof Row>,
  ) => {
    await prisma.$transaction(async (tx) => {
      const held = await tx.$queryRaw<
        { sessionId: string; resumeRequired: boolean }[]
      >`SELECT "sessionId", "resumeRequired" FROM runs WHERE id = ${runId} AND "leaseFence" = ${fence} AND status IN ('running', 'waiting_input', 'waiting_takeover') FOR UPDATE`;
      if (held.length !== 1 || !held[0]) throw new Error("Resume state fence was revoked");
      if (previous && held[0].sessionId !== run.sessionId)
        throw new Error("Resume session was revoked");
      run.sessionId = held[0].sessionId;
      const rows = await tx.$queryRaw<
        unknown[]
      >`SELECT "sessionId", snapshot, receipts FROM run_snapshots WHERE "runId" = ${runId}`;
      if (held[0].resumeRequired && rows.length === 0)
        throw new Error("Required resume snapshot is missing");
      const existing = rows.length ? Row.parse(mask(rows[0])) : undefined;
      if (existing && existing.sessionId !== held[0].sessionId)
        throw new Error("Resume session was revoked");
      const state = update(existing);
      const snapshot = JSON.stringify(mask(state.snapshot));
      const receipts = JSON.stringify(mask(state.receipts));
      if (
        Buffer.byteLength(snapshot) > RUN_SNAPSHOT_BYTES ||
        Buffer.byteLength(receipts) > RUN_RECEIPTS_BYTES
      )
        throw new Error("Durable resume state exceeds its transfer limit");
      const delivered = await tx.sessionEntry.findMany({
        where: {
          id: { in: state.snapshot.deliveredEvents },
          sessionId: run.thread.sessionId ?? run.sessionId,
          type: { in: ["helper.report", "helper.question"] },
        },
        select: { seq: true },
      });
      const through = delivered.reduce((next, entry) => Math.max(next, entry.seq + 1), 0);
      await tx.$executeRaw`UPDATE runs SET "resumeRequired" = TRUE, "historyThroughSeq" = GREATEST(COALESCE("historyThroughSeq", 0), ${through}) WHERE id = ${runId}`;
      await tx.$executeRaw`INSERT INTO run_snapshots ("runId", "sessionId", snapshot, receipts) VALUES (${runId}, ${run.sessionId}, ${snapshot}::jsonb, ${receipts}::jsonb) ON CONFLICT ("runId") DO UPDATE SET snapshot = EXCLUDED.snapshot, receipts = EXCLUDED.receipts`;
    });
  };
  return {
    start: previous
      ? { mode: "resume", snapshot: previous.snapshot, receipts: previous.receipts }
      : { mode: legacy ? "legacy" : "fresh" },
    async save(input: RunSnapshot) {
      const snapshot = RunSnapshotSchema.parse(input);
      await mutate((state) => {
        if (
          state &&
          (snapshot.harness.name !== state.snapshot.harness.name ||
            snapshot.harness.format !== state.snapshot.harness.format ||
            snapshot.revision <= state.snapshot.revision)
        )
          throw new Error("Incompatible or stale resume snapshot");
        return { sessionId: run.sessionId, snapshot, receipts: state?.receipts ?? [] };
      });
    },
    async receipt(input: RunReceipt) {
      await mutate((state) => {
        const receipt = RunReceiptSchema.parse(mask(input));
        if (!state) throw new Error("A durable call requires a native snapshot");
        const prior = state.receipts.find((item) => item.callId === receipt.callId);
        if (
          prior &&
          (prior.name !== receipt.name ||
            !isDeepStrictEqual(prior.args, receipt.args) ||
            (prior.effectId !== undefined &&
              receipt.effectId !== undefined &&
              prior.effectId !== receipt.effectId) ||
            prior.outcome.kind === "result")
        )
          throw new Error("Conflicting durable call receipt");
        return {
          ...state,
          receipts: [
            ...state.receipts.filter((item) => item.callId !== receipt.callId),
            {
              ...receipt,
              ...((receipt.effectId ?? prior?.effectId)
                ? { effectId: receipt.effectId ?? prior?.effectId }
                : {}),
            },
          ],
        };
      });
    },
    async resolve() {
      const current = await read();
      if (!current) {
        const marker = await prisma.run.findUniqueOrThrow({
          where: { id: runId },
          select: { resumeRequired: true },
        });
        if (marker.resumeRequired) throw new Error("Required resume snapshot is missing");
      }
      return current?.receipts ?? [];
    },
  };
}
