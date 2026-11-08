-- A member of an organization is no longer implicitly a member of its default
-- Space: invited people join only the Space their link names.
DROP TRIGGER IF EXISTS "member_default_space_membership" ON "member";
DROP FUNCTION IF EXISTS ensure_default_space_membership();

-- CreateTable
CREATE TABLE "space_invitations" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "space_invitations_tokenHash_key" ON "space_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "space_invitations_spaceId_expiresAt_idx" ON "space_invitations"("spaceId", "expiresAt");

-- AddForeignKey
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
