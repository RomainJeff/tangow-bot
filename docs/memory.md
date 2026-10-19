# Memory

On web and desktop, open **Memory** from the user menu for personal memories, or from bot and Space settings for their collections. The library separates three collections: **Personal** memories, **Bot** memories belonging to one bot, and **Space** memories shared with the current Space. Terms are defined in the [glossary](../GLOSSARY.md); the main design decisions are recorded in [ADRs](adr/).

## Read and manage

The library is a reading surface: search, Markdown rendering, sources, labels and revision history. It has no editing or classification form. **Remember** on a message still captures it with its source.

Choose an ordinary bot to manage memory. In **Bot settings → Advanced → Skills**, enable **memory-management** for that bot. It starts unassigned. Put your categories, definitions and examples in the bot's existing **Instructions**, then ask it to apply them in its conversation. There is no separate classification settings panel and no required taxonomy.

The bot can search Personal and Space memories and its own Bot collection. It cannot access another bot's collection. Space members can read Space memories and publish their own; editing and withdrawal retain the existing author and Space-owner checks. Space ownership never grants access to someone else's Personal memory.

Ask the bot to create, update, import, consolidate, accept, withdraw, restore or publish a memory. Each write displays its exact request for one-time confirmation in the conversation; the bot cannot approve its own request, and automatic approval rules do not apply. The server checks access and revisions again when executing it. Publication copies only the approved text to the Space; the original remains private and subsequent edits do not propagate automatically.

Previously saved types, subjects, importance, objectives and key results remain readable in historical data. Classification adds annotations; it does not change content, permissions or lifecycle.

## Proposals and withdrawal

**Remember** is a human capture: the memory is active immediately. A bot's memory tools and automatic extraction from a compacted conversation create **proposals**. They become eligible for recall only after explicit acceptance. Editing a proposal does not accept it, and editing a withdrawn memory does not restore it.

Automatic extraction produces individual candidates with a citation to the original message. The server checks the message version, exact quoted text and access before storing evidence. A user message and an assistant message retain distinct provenance; a verified citation verifies where the text came from, not whether the statement is true.

Compaction records its extraction request durably with the conversation cursor and the current history generation. Failed extraction is retried with bounded backoff, and repeated candidates do not create repeated proposals. A rewind or clear that starts a new history generation, a changed source message, a withdrawn memory dependency or lost membership marks a pending request stale before it writes anything. A rejected candidate with unchanged source and content remains rejected. Short conversations that never compact are not automatically captured by this trigger; use **Remember** or the bot's memory tool when appropriate.

Withdrawal excludes a memory from future recall. Previously published copies are independent and must be withdrawn separately if that is the intended outcome. Historical messages are not rewritten: removing a memory is different from erasing every occurrence of the same information from its original sources.

Memory content is background data. It cannot grant a bot permissions, authorize an external action or override the product's instruction hierarchy. Access checks, lifecycle checks and revision checks remain server-side.

## Recall and the memory manifest

Recall reads only active memories the run is authorized to see, through the canonical library; it works locally without a hosted memory provider. Each run records a **manifest** of the memory revisions it was given. Before every model call and tool call, the run checks its manifest again; if a memory was withdrawn, edited or changed access, the run stops instead of continuing with stale context. Compacted summaries and earlier bot replies carry their own manifests and are replayed only while those are still authorized; a missing or unreadable manifest is treated as unauthorized. Runs recorded before the memory library had no governed memory dependencies, so their manifests are empty and their history replays normally.

## Classify and consolidate

The chosen bot prepares bounded choice criteria from its current Instructions. You approve those exact criteria in the conversation. The Space's decision provider supplies labels; the conversational model coordinates the tools and explains results. The decision model does not generate the criteria or run the bot by itself.

A classification remains a suggestion until you validate or correct it in the same conversation. The bot submits your answers for one-time confirmation; it cannot approve its own suggestion. Changing the source memory or the bot Instructions invalidates stale classification and review requests. Each run is recorded with the bot, method version, source revision and prediction; different bots keep separate methods and annotations on the same memory.

The current format supports up to eight independent criteria with nineteen choices each, plus no match. No taxonomy is imposed. These management tools are available only in the selected bot's private, user-triggered conversation. Groups, messaging channels, scheduled runs and delegated helpers do not receive them.

For consolidation, the bot reads two to eight active memories from one collection, proposes a Markdown synthesis and asks for confirmation. Acceptance can explicitly replace the sources or keep them. Replaced sources remain in history. Changed or unavailable sources invalidate dependent syntheses for recall. OKF import through the bot also creates a proposal: metadata claiming approval, authorship or permissions remains inert.

Embeddings and automatic clustering are not part of this release. Learning is contextual reuse of reviewed examples, not weight training.

## Decision provider

Classification uses the Space's decision provider, the same connection that serves `browser_run`: a Space owner connects it in **Settings → Decision Model** on web and desktop (see [self-hosting](self-host.md)). There is no memory-specific key or model setting. Memory content goes to the provider only after the acting user has allowed memory analysis under data sharing; connecting the provider and allowing memory analysis are separate decisions.

If no decision provider is connected when criteria are prepared, the local reviewed-examples adapter is used. Disconnecting the provider does not silently switch a method to another model; re-preparing after a connection change requires confirmation.

Classification sends the selected memory, up to eight authorized neighbors and up to four eligible reviewed examples. Preparation happens in the bot conversation using its normal model and approved Instructions; the decision provider receives the bounded classification request separately. Saving a method does not schedule autonomous classification or automatically accept captured memories.

## Learn from classification reviews

Each validation preserves the original prediction and the corrected values. Future classifications can reuse relevant examples immediately, scoped to the same **bot, method version and collection**. Method changes create a new version; feedback from the previous version remains in history and does not silently transfer. Feedback is never recall content.

Methods and new corrections stay private to the selected bot and reviewer. Existing historical annotations remain readable. The same bot can manage Personal and Space memories; another bot's collection remains excluded.

Ask the bot to stop learning from a review to **revoke** it after confirmation. The annotation and audit remain. Changed content, invalid or withdrawn sources, expired validity, revoked membership and unavailable neighbors make examples ineligible too. Revoking a newer correction does not reactivate an older correction it replaced. Contradictory labels for the same content are not resolved by picking the newest; that signal is omitted.

Examples and source text remain untrusted data. Questions and allowed answers come exclusively from the prepared method, with bounds and validation at the provider boundary. This contains the effects of hostile text but is not a guarantee that a model can never be influenced semantically by it. Neither labels nor model confidence grant permissions or establish factual truth.

The local provider reuses eligible, non-conflicting human labels only for identical content and otherwise abstains. The decision provider receives bounded reviewed examples as contextual guidance; this does not retrain its weights. API validity, browser tests and database tests do not establish semantic accuracy. Evaluate each method against independently annotated examples before claiming an accuracy gain.

## Existing installations

The database migration preserves existing Markdown documents and their revisions. Legacy user documents remain personal; they do not become Space memories merely because the old settings screen called them "Shared documents". Documents without verifiable human activation enter the proposal list for review.

Recall from the existing Serenity and Supermemory connections is paused, and saving to them is paused too: their current integration does not resolve results to canonical document revisions. Connection settings are retained, but connecting a provider does not enable recall. Existing provider-only facts are not automatically imported or treated as approved knowledge. Keep a separate provider export when available and review material before adding it to the library.

Back up the database before a deployment migration and deploy the API and workers together. Do not keep an older worker running alongside the new memory lifecycle: it can still use the old automatic write path. A rollback of application binaries alone does not reverse the migration or restore old memory behavior safely.

## Deployment sequence

1. Pause incoming runs and stop old workers after their current jobs finish. Preserve pending jobs for the upgraded worker; do not let the old and new memory writers overlap.
2. Back up the database. Apply the versioned migrations once through the deployment migration runner.
3. Compare document and revision counts with the backup. Existing IDs, Markdown bodies and revision numbers must remain unchanged; the migration must not create Space publications from personal documents.
4. Start the upgraded API and workers together. Verify one Personal memory and one Space publication using separate test identities, then resume incoming runs.
5. Read inherited proposals in the library and ask the selected bot to review them. Provider-only data is outside the migration coverage; recover it through a provider export when available and import only reviewed content.

For a controlled rollout or incident, an operator can set `Space.memoryRecallEnabled` to `false` for the affected Space. The library and its revision history remain available, but canonical reads and searches return no recall candidates. Runs revalidate their manifest before subsequent model calls and tools; disabling recall does not retract text already sent. Set the field back to `true` after verification. Do not roll back to an older worker or restore direct provider injection as a fallback.

The automatic safety checks cover governed memory and its recorded dependencies. They do not erase an independently present fact from an authorized source message. No deterministic test suite proves that every model will ignore every malicious instruction embedded in text.
