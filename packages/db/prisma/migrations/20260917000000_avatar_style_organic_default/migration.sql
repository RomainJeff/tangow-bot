-- The organic avatar is now the default look; a new account starts on it and can still opt
-- into the robot avatar from Settings.
ALTER TABLE "user" ALTER COLUMN "avatarStyle" SET DEFAULT 'organic';

-- Every existing row carries the old column default, so it cannot be told apart from an
-- explicit choice: move everyone to the organic look; the robot look stays a per-user opt-in.
UPDATE "user" SET "avatarStyle" = 'organic' WHERE "avatarStyle" = 'robot';
