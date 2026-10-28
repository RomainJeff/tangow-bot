ALTER TABLE "volumes" DROP CONSTRAINT "volumes_writerAttemptId_fkey";
DROP INDEX "volumes_writerAttemptId_idx";
ALTER TABLE "volumes" DROP COLUMN "writerAttemptId";
