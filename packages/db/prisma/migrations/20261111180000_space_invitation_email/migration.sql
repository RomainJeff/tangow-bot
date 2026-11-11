-- Invites are now bound to one email and the id is the link token. Earlier
-- links named no one and expire within a week, so they are dropped.
DELETE FROM "space_invitations";

-- DropIndex
DROP INDEX "space_invitations_tokenHash_key";

-- AlterTable
ALTER TABLE "space_invitations" DROP COLUMN "tokenHash",
ADD COLUMN     "email" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "space_invitations_spaceId_email_key" ON "space_invitations"("spaceId", "email");
