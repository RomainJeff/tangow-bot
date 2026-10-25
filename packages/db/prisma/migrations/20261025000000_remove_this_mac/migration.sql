-- "This Mac" was removed, so a computer that ran on the host can no longer be reached. Drop the
-- dead reference the way a computer replacement does; the next boot provisions a new computer on
-- the configured provider and restores the saved workspace.
UPDATE "computers"
SET
    "state" = 'stopped',
    "providerRef" = NULL,
    "controlHolder" = 'none',
    "controlLeaseId" = NULL,
    "controlLeaseExpiresAt" = NULL,
    "controlBotId" = NULL,
    "controlRunId" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" = 'desktop';

ALTER TABLE "deployment_settings" DROP COLUMN "computerHost";
