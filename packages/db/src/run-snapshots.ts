import { isDeepStrictEqual } from "node:util";
import type { RunPersistence, RunReceipt, RunSnapshot } from "@rakazo/adapter-kit";
import {
  RUN_RECEIPTS_BYTES,
  RUN_SNAPSHOT_BYTES,
  RunReceiptSchema,
  RunResumeError,
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

/** Only attempt initialization and pause saves access the database; receipts stay in memory. */
export async function runPersistence(
  prisma: PrismaClient,
  runId: string,
  fence: number,
  secrets: readonly string[],
  legacy: boolean,
): Promise<RunPersistence> {
  const mask = (value: unknown) => JSON.parse(redactSecrets(JSON.stringify(value), [...secrets]));
  const initial = await prisma.$transaction(async (tx) => {
    const [held] = await tx.$queryRaw<
      { sessionId: string; threadSessionId: string | null; resumeRequired: boolean }[]
    >`SELECT r."sessionId", t."sessionId" AS "threadSessionId", r."resumeRequired"
      FROM runs r JOIN threads t ON t.id = r."threadId"
      WHERE r.id = ${runId} AND r."leaseFence" = ${fence}
        AND r.status IN ('running', 'waiting_input', 'waiting_takeover') FOR UPDATE OF r`;
    if (!held) throw new Error("Resume state fence was revoked");
    const rows = await tx.$queryRaw<
      unknown[]
    >`SELECT "sessionId", snapshot, receipts FROM run_snapshots WHERE "runId" = ${runId}`;
    const previous = rows.length ? Row.parse(mask(rows[0])) : undefined;
    if (held.resumeRequired && !previous)
      throw new RunResumeError("Required pause snapshot is missing");
    if (previous && previous.sessionId !== held.sessionId)
      throw new Error("Resume state belongs to a different session");
    return { ...held, previous };
  });
  let begun = false;
  let revision = initial.previous?.snapshot.revision ?? -1;
  const receipts = new Map(initial.previous?.receipts.map((receipt) => [receipt.callId, receipt]));
  return {
    start: initial.previous
      ? { mode: "resume", snapshot: initial.previous.snapshot, receipts: initial.previous.receipts }
      : { mode: legacy ? "legacy" : "fresh" },
    async begin() {
      if (begun) return;
      await prisma.$transaction(async (tx) => {
        const [held] = await tx.$queryRaw<{ sessionId: string }[]>`SELECT "sessionId" FROM runs
          WHERE id = ${runId} AND "leaseFence" = ${fence} AND status = 'running' FOR UPDATE`;
        if (!held) throw new Error("Resume state fence was revoked");
        if (initial.previous && held.sessionId !== initial.sessionId)
          throw new Error("Resume session was revoked");
        initial.sessionId = held.sessionId;
        if (initial.previous) {
          const removed = await tx.$executeRaw`DELETE FROM run_snapshots WHERE "runId" = ${runId}
            AND "sessionId" = ${held.sessionId} AND snapshot->>'revision' = ${String(initial.previous.snapshot.revision)}`;
          if (removed !== 1) throw new RunResumeError("Required pause snapshot is missing");
        }
        if (!initial.resumeRequired)
          await tx.$executeRaw`UPDATE runs SET "resumeRequired" = TRUE WHERE id = ${runId}`;
      });
      begun = true;
    },
    async save(input: RunSnapshot) {
      const snapshot = RunSnapshotSchema.parse(mask(input));
      if (
        snapshot.revision <= revision ||
        (initial.previous &&
          (snapshot.harness.name !== initial.previous.snapshot.harness.name ||
            snapshot.harness.format !== initial.previous.snapshot.harness.format))
      )
        throw new Error("Incompatible or stale resume snapshot");
      const pending = new Set(snapshot.pendingCallIds);
      const retained = [...receipts.values()].filter((receipt) => pending.has(receipt.callId));
      const encodedSnapshot = JSON.stringify(snapshot);
      const encodedReceipts = JSON.stringify(mask(retained));
      if (
        Buffer.byteLength(encodedSnapshot) > RUN_SNAPSHOT_BYTES ||
        Buffer.byteLength(encodedReceipts) > RUN_RECEIPTS_BYTES
      )
        throw new Error("Pause resume state exceeds its transfer limit");
      await prisma.$transaction(async (tx) => {
        const [held] = await tx.$queryRaw<{ sessionId: string }[]>`SELECT "sessionId" FROM runs
          WHERE id = ${runId} AND "leaseFence" = ${fence}
          AND status IN ('running', 'queued', 'waiting_input', 'waiting_takeover') FOR UPDATE`;
        if (!held) throw new Error("Resume state fence was revoked");
        if (initial.previous && held.sessionId !== initial.sessionId)
          throw new Error("Resume session was revoked");
        const delivered = snapshot.deliveredEvents.length
          ? await tx.sessionEntry.findMany({
              where: {
                id: { in: snapshot.deliveredEvents },
                sessionId: initial.threadSessionId ?? initial.sessionId,
                type: { in: ["helper.report", "helper.question"] },
              },
              select: { seq: true },
            })
          : [];
        const through = delivered.reduce((next, entry) => Math.max(next, entry.seq + 1), 0);
        await tx.$executeRaw`UPDATE runs SET "historyThroughSeq" = GREATEST(COALESCE("historyThroughSeq", 0), ${through}) WHERE id = ${runId}`;
        await tx.$executeRaw`INSERT INTO run_snapshots ("runId", "sessionId", snapshot, receipts)
          VALUES (${runId}, ${held.sessionId}, ${encodedSnapshot}::jsonb, ${encodedReceipts}::jsonb)
          ON CONFLICT ("runId") DO UPDATE SET snapshot = EXCLUDED.snapshot, receipts = EXCLUDED.receipts`;
      });
      revision = snapshot.revision;
    },
    async receipt(input: RunReceipt) {
      const receipt = RunReceiptSchema.parse(mask(input));
      const prior = receipts.get(receipt.callId);
      if (
        prior &&
        (prior.name !== receipt.name ||
          !isDeepStrictEqual(prior.args, receipt.args) ||
          prior.outcome.kind === "result")
      )
        throw new Error("Conflicting pause call receipt");
      receipts.set(receipt.callId, {
        ...receipt,
        ...((receipt.effectId ?? prior?.effectId)
          ? { effectId: receipt.effectId ?? prior?.effectId }
          : {}),
      });
    },
    async resolve() {
      return [...receipts.values()].map((receipt) => RunReceiptSchema.parse(mask(receipt)));
    },
  };
}
