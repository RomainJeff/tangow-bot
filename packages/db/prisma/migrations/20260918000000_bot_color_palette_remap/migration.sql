-- The bot identity palette moved to the "Taille douce — direction poussée" hues.
-- Remap every bot still carrying an old swatch to its nearest new hue; rows already
-- on a new colour (or a custom one) are left untouched.
UPDATE "bots" SET "color" = '#3BC9A0' WHERE "color" = '#3EC5A8';
UPDATE "bots" SET "color" = '#F0913A' WHERE "color" = '#F5A03C';
UPDATE "bots" SET "color" = '#8B5CF6' WHERE "color" = '#6A6BF5';
UPDATE "bots" SET "color" = '#8B5CF6' WHERE "color" = '#9B5CF6';
UPDATE "bots" SET "color" = '#2E8CF0' WHERE "color" = '#3B82F6';
UPDATE "bots" SET "color" = '#E0524A' WHERE "color" = '#F2622A';
UPDATE "bots" SET "color" = '#E45C9C' WHERE "color" = '#D9508A';
