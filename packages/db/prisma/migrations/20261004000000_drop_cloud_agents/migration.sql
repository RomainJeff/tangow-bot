-- Cloud agents (Cursor) were removed. Rewrite rows the API schemas no longer accept.
UPDATE "runs" SET "trigger" = 'resume' WHERE "trigger" = 'cloud_agent';
DELETE FROM "events" WHERE "type" = 'thread.cloud_agent';
DROP TABLE IF EXISTS "cloud_agents";
