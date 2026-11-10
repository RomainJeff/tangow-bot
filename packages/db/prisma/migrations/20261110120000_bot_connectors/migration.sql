-- The apps a shared bot needs. A member's run sees only these, with the member's own accounts.
ALTER TABLE "bots" ADD COLUMN "connectors" JSONB NOT NULL DEFAULT '[]';
