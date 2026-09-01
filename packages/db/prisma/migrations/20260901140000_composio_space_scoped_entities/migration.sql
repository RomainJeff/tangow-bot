-- Composio entities are now scoped per space ("<spaceId>__<userId>"), so every connected
-- account created under the old user-only entity is unreachable. Mark those rows revoked so
-- the UI shows them disconnected and the owner reconnects once per space.
UPDATE "connections"
SET "status" = 'revoked'
WHERE "connectorId" = 'composio' AND "status" IN ('pending', 'connected', 'error');
