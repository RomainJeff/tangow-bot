-- A provider boot fences only the provisioner that claimed it. Generic Computer writes
-- (for example a Docker workspace checkpoint) must not invalidate that fence via updatedAt.
ALTER TABLE "computers" ADD COLUMN "bootClaimStamp" TIMESTAMP(3);
