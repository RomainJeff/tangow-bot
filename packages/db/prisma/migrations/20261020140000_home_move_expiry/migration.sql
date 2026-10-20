ALTER TABLE computers ADD COLUMN "homeMoveExpiresAt" TIMESTAMP(3);

-- Existing reservations get a grace period for their owner to stop or renew.
UPDATE computers SET "homeMoveExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute'
WHERE "maintenanceId" LIKE 'home-move:%';
