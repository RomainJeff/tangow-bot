-- An entry that rose from a child session to its thread's main session names that child in its
-- payload as originSessionId, so a child session's story is found without a column. Guarded to
-- rerun. A plain build blocks writes to session_entries while it scans, short while the table is new.
CREATE INDEX IF NOT EXISTS "session_entries_originSessionId_idx"
    ON "session_entries" ((payload ->> 'originSessionId'))
    WHERE payload ->> 'originSessionId' IS NOT NULL;
