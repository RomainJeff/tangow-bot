# Memory

The memory library separates three collections: **Personal** memories, **Bot** memories belonging to one bot, and **Space** memories shared with the current Space. Terms are defined in the [glossary](../GLOSSARY.md); the main design decisions are recorded in [ADRs](adr/).

## Library

Every memory is a versioned Markdown document with its sources, an access scope and a lifecycle status. Space members can read Space memories and publish their own; editing and withdrawal retain the existing author and Space-owner checks. Space ownership never grants access to someone else's Personal memory, and a bot never reads another bot's collection. Publication copies only the approved text to the Space; the original remains private and subsequent edits do not propagate automatically.

Every write carries the revision it was made against, so a stale edit is rejected instead of overwriting a newer one. Consolidation proposes a Markdown synthesis of two to eight active memories from one collection; acceptance can explicitly replace the sources or keep them, and replaced sources remain in history. OKF import creates a proposal: metadata claiming approval, authorship or permissions remains inert.

## Proposals and withdrawal

**Remember** is a human capture: the memory is active immediately, with the remembered message stored as evidence. A bot's memory tools and automatic extraction from a compacted conversation create **proposals**. They become eligible for recall only after explicit acceptance. Editing a proposal does not accept it, and editing a withdrawn memory does not restore it.

Automatic extraction produces individual candidates with a citation to the original message. The server checks the message version, exact quoted text and access before storing evidence. A user message and an assistant message retain distinct provenance; a verified citation verifies where the text came from, not whether the statement is true.

Compaction records its extraction request durably with the conversation cursor and the current history generation. Failed extraction is retried with bounded backoff, and repeated candidates do not create repeated proposals. A rewind or clear that starts a new history generation, a changed source message, a withdrawn memory dependency or lost membership marks a pending request stale before it writes anything. A rejected candidate with unchanged source and content remains rejected. Short conversations that never compact are not automatically captured by this trigger; use **Remember** or the bot's memory tool when appropriate.

Withdrawal excludes a memory from future recall. Previously published copies are independent and must be withdrawn separately if that is the intended outcome. Historical messages are not rewritten: removing a memory is different from erasing every occurrence of the same information from its original sources.

Memory content is background data. It cannot grant a bot permissions, authorize an external action or override the product's instruction hierarchy. Access checks, lifecycle checks and revision checks remain server-side.

## Recall and the memory manifest

Recall reads only active memories the run is authorized to see, through the canonical library; it works locally without a hosted memory provider. Each run records a **manifest** of the memory revisions it was given. Before every model call and tool call, the run checks its manifest again; if a memory was withdrawn, edited or changed access, the run stops instead of continuing with stale context. Compacted summaries and earlier bot replies carry their own manifests and are replayed only while those are still authorized; a missing or unreadable manifest is treated as unauthorized. Runs recorded before the memory library had no governed memory dependencies, so their manifests are empty and their history replays normally.

## Existing installations

The database migration preserves existing Markdown documents and their revisions. Legacy user documents remain personal; they do not become Space memories merely because the old settings screen called them "Shared documents". Documents without verifiable human activation enter the proposal list for review.

Recall from the existing Serenity and Supermemory connections is paused, and saving to them is paused too: their current integration does not resolve results to canonical document revisions. Connection settings are retained, but connecting a provider does not enable recall. Existing provider-only facts are not automatically imported or treated as approved knowledge. Keep a separate provider export when available and review material before adding it to the library.

Back up the database before a deployment migration and deploy the API and workers together. Do not keep an older worker running alongside the new memory lifecycle: it can still use the old automatic write path. A rollback of application binaries alone does not reverse the migration or restore old memory behavior safely.

## Deployment sequence

1. Pause incoming runs and stop old workers after their current jobs finish. Preserve pending jobs for the upgraded worker; do not let the old and new memory writers overlap.
2. Back up the database. Apply the versioned migrations once through the deployment migration runner.
3. Compare document and revision counts with the backup. Existing IDs, Markdown bodies and revision numbers must remain unchanged; the migration must not create Space publications from personal documents.
4. Start the upgraded API and workers together. Verify one Personal memory and one Space publication using separate test identities, then resume incoming runs.

For a controlled rollout or incident, an operator can set `Space.memoryRecallEnabled` to `false` for the affected Space. The library and its revision history remain available, but canonical reads and searches return no recall candidates. Runs revalidate their manifest before subsequent model calls and tools; disabling recall does not retract text already sent. Set the field back to `true` after verification. Do not roll back to an older worker or restore direct provider injection as a fallback.
