-- Keep an in-flight create's deadline after owner deletion, even if its response was lost.
ALTER TABLE "volumes" ADD COLUMN "ensureUntil" TIMESTAMP(3);
ALTER TABLE "volume_deletions" ADD COLUMN "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Unlike a row-local counter, the sequence never restarts after deletion and reinsertion.
CREATE SEQUENCE volume_deletion_generation_seq AS INTEGER;
SELECT setval('volume_deletion_generation_seq',
    COALESCE((SELECT max(generation) FROM volume_deletions), 0) + 1, false);
ALTER SEQUENCE volume_deletion_generation_seq OWNED BY volume_deletions.generation;
ALTER TABLE volume_deletions ALTER COLUMN generation
    SET DEFAULT nextval('volume_deletion_generation_seq');
