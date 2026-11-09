-- A shared volume belongs to one person in its Space, as does its skill index receipt.
ALTER TABLE "volumes" ADD COLUMN "userId" TEXT;
ALTER TABLE "volumes" ADD COLUMN "skillIndexReceivedAt" TIMESTAMP(3);

UPDATE "volumes" v SET
    "userId" = COALESCE(
        (SELECT m."userId" FROM "space_members" m
            WHERE m."spaceId" = v."spaceId" AND m."role" = 'owner'
            ORDER BY m."createdAt" LIMIT 1),
        s."createdByUserId"),
    "skillIndexReceivedAt" = s."skillIndexReceivedAt"
FROM "spaces" s
WHERE s."id" = v."spaceId" AND v."kind" = 'space_shared';

DROP INDEX "volumes_spaceId_shared_key";
CREATE UNIQUE INDEX "volumes_spaceId_userId_shared_key" ON "volumes"("spaceId", "userId")
    WHERE "kind" = 'space_shared';

ALTER TABLE "spaces" DROP COLUMN "skillIndexReceivedAt";
