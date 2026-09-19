-- The organic avatar is now the default look; a new account starts on it and can still opt into
-- the robot avatar from Settings.
ALTER TABLE "user" ALTER COLUMN "avatarStyle" SET DEFAULT 'organic';

-- No backfill. "avatarStyle" is NOT NULL and has defaulted to 'robot' since it was added, so a
-- stored 'robot' cannot be told apart from a user who picked robot in Settings › Appearance.
-- Rewriting those rows would silently overturn that choice for the users who made it, so existing
-- accounts keep the look they already have and only new accounts start organic.
