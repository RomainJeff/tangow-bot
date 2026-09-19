-- The organic avatar is now the default look; the robot avatar stays available from Settings.
ALTER TABLE "user" ALTER COLUMN "avatarStyle" SET DEFAULT 'organic';

-- One-off switch: every account moves to the redesigned organic avatar, including those that
-- had picked robot before (a deliberate product call; robot can be re-selected in Settings).
UPDATE "user" SET "avatarStyle" = 'organic' WHERE "avatarStyle" = 'robot';
