-- A Space can have several people, and each keeps their own team computer and /workspace/shared.
-- Existing Spaces have one person, so their computer and shared volume stay the same rows.

-- A team computer belongs to one person: `team:<spaceId>:<userId>`. homeKey never moves.
UPDATE "computers" SET "scopeKey" = 'team:' || "spaceId" || ':' || "userId" WHERE "scope" = 'team';
