-- A routine a bot creates mid-chain used to restart the bot-to-bot hop count at zero. Keep the
-- hop it was created at, so runs of the routine continue the chain; null for person-made routines.
ALTER TABLE "routines" ADD COLUMN "inheritedHop" INTEGER;
