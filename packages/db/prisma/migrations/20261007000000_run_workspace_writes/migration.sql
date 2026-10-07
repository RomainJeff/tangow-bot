-- CreateTable
CREATE TABLE "run_workspace_writes" (
    "runId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "run_workspace_writes_pkey" PRIMARY KEY ("runId","path")
);

-- AddForeignKey
ALTER TABLE "run_workspace_writes" ADD CONSTRAINT "run_workspace_writes_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
