-- Keep exact source evidence separate from proposal content and qualify it by revision.
CREATE TABLE "memory_evidence" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceRole" TEXT,
  "sourceReferenceId" TEXT NOT NULL,
  "sourceVersion" TEXT NOT NULL,
  "sourceDigest" TEXT NOT NULL,
  "startOffset" INTEGER,
  "endOffset" INTEGER,
  "excerpt" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_evidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "memory_evidence_documentId_revision_sourceKind_sourceReferenceId_sourceVersion_key"
  ON "memory_evidence"("documentId", "revision", "sourceKind", "sourceReferenceId", "sourceVersion");
CREATE INDEX "memory_evidence_sourceKind_sourceReferenceId_idx"
  ON "memory_evidence"("sourceKind", "sourceReferenceId");
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "memory_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_evidence" ADD CONSTRAINT "memory_evidence_documentId_revision_fkey"
  FOREIGN KEY ("documentId", "revision") REFERENCES "memory_revisions"("documentId", "revision") ON DELETE CASCADE ON UPDATE CASCADE;

