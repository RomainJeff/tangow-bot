# Interactive run memory

Interactive work keeps tool calls and results in a child session. The parent conversation retains user messages, public `message_user` replies, approval and question context, and an internal factual recap. Web, desktop, and mobile use the same stored conversation and UI projection. A recap creates no message bubble or unread state.

## Conversation and execution context

The next interactive run reads the parent conversation and its own active child context. It does not expand completed child traces, even for the most recent run. Completed legacy mainline traces project as run and session references without deleting stored entries. Unmarked legacy public replies and raised cards remain conversation. Explicitly private text, raw tool replay, and private reasoning do not become recaps.

Each `run.recap` contains a run ID, child session ID, truthful terminal status, and either bounded structured facts or a missing-facts reason. Facts describe results, decisions, and limits, with retained tool references. The inference projection escapes the record as historical data. Only the bot that owns the recap reads its facts. A failed or cancelled run never becomes a fabricated success.

A missing, invalid, or interrupted closing keeps its run reference searchable. The executor does not manufacture a recap from raw private final prose.

## Search after compaction

`search_runs` without a run ID discovers authorized runs by task prompt or stored factual recap. A query can identify a fact absent from the original prompt, even after multiple compactions remove its recap and ID from the visible tail. Discovery is paginated. It does not dump the archive into the prompt.

With a run ID and literal query, search returns bounded retained excerpts with entry IDs and timestamps. Child tool results and raised parent replies share the authorized scope. Callers continue through `nextCursor`, including pages with no hits. Reasoning, source-message bodies, and peer deliveries are excluded from text search. Discarded output cannot be recovered.

Authorization checks the caller's owner, space, bot, and conversation before exposing metadata or excerpts. A fresh interactive child is authorized by its active parent source entry. Source-less work requires the parent `run.opened` anchor for that child and run. Rewind and clear revoke removed anchors. Another bot's private recap remains inaccessible.

## History capacity and active work

Finished interactive history has a candidate ceiling of 60,000 estimated tokens. Known usable history capacity subtracts measured fixed context, active run context, and the reply reserve from the model window. The smaller capacity wins, without a recent-history floor. The reply reserve covers at least 16,384 tokens and any larger output cap that Pi actually requests. The executor uses the same `resolveCompletionMaxTokens` helper as Pi, including its existing default and model maximum.

The executor separates active context by run identity before choosing finished history. The current source message is counted once, in the prompt, matching Pi's source-ID deduplication. Summary and recall blocks share the remaining historical allowance, with the summary first. A block that cannot fit is omitted whole rather than cut inside its data wrapper. A later smaller block can still fit. Stored memories and archived runs remain available through their existing retrieval tools. It preserves active tool exchanges and steering rather than silently dropping their effects. If known capacity cannot fit the fixed prompt, active run, and output reserve, the run fails before model execution. The existing failure path displays `Model context cannot fit the fixed prompt, active run, and reply reserve`.

For an unknown model window, finished history obeys both the 200-turn limit and the 60,000-token estimate. Active context remains separate. This is not a guarantee about total prompt capacity or provider tokenization.

Compaction summarizes the safe parent conversation and can compact old recaps. The archive catalog remains the route to older IDs. Durable memory loading, semantic recall, and durable-fact extraction keep their existing roles. A remembered preference and an archived task result have different sources.

Messaging runs and follow-ups sourced from a channel retain their original main session, provenance filtering, replay, and history policy. Archive search denies unsafe channel lookup. Channel archive reduction is deferred.

## Verification and rollback

The offline tests use migrated PGlite, the real executor, and Pi with a local model emulator. They cover archived fact retrieval without repeated file or web work, catalog discovery after compaction, access revocation, projection privacy, and context capacity. These tests do not measure real-model recap quality or latency.

Storage is append-only throughout this change. Rolling back projection code must keep both child and raised parent records readable. Re-enabling broader replay requires explicitly reading child sessions again. Changing only the parent projection cannot restore their tool traces.
