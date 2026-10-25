import { STOP_PHASES, type StopPhase } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/** The only writer of `attempts.stopPhase`. A phase never moves back. */
export interface StopJournal {
  mark(attemptId: string, phase: StopPhase): Promise<void>;
}

export function createStopJournal(prisma: PrismaClient): StopJournal {
  const order = [...STOP_PHASES];
  return {
    async mark(attemptId, phase) {
      await prisma.$executeRaw`
        UPDATE attempts SET "stopPhase" = ${phase}, "stopPhaseAt" = ${new Date()}
        WHERE id = ${attemptId}
          AND ("stopPhase" IS NULL
            OR array_position(${order}::text[], "stopPhase") < array_position(${order}::text[], ${phase}))`;
    },
  };
}
