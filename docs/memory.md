# Memory

On web and desktop, open **Memory** from the user menu for personal memories, or from agent and space settings for their collections. On mobile, the memory entry opens the same collection choices. The library separates personal memories, memories belonging to one agent, and memories shared with the current space.

## Read and manage

The library is a reading surface: search, Markdown rendering, sources, labels and revision history. It has no editing or classification form. **Remember** on a message still captures it with its source.

Choose an ordinary bot to manage memory. In **Bot settings → Advanced → Skills**, enable **Memory management** for that bot. It starts unassigned. Put your categories, definitions and examples in the bot's existing **Instructions**, then ask it to apply them in its conversation. There is no separate classification settings panel and no required taxonomy.

The bot can search personal and Space memories and its own private agent collection. It cannot access another bot's private collection. Space members can read shared memories and publish their own; editing and withdrawal retain the existing author and Space-owner checks. Space ownership never grants access to someone else's personal memory.

Ask the bot to create, update, import, consolidate, accept, withdraw, restore or publish a memory. Each write displays its exact request for one-time confirmation in the conversation. The server checks access and revisions again when executing it. Publication copies only the approved text to the Space; the original remains private and subsequent edits do not propagate automatically.

Previously saved types, subjects, importance, objectives and key results remain readable in historical data. Classification adds annotations; it does not change content, permissions or lifecycle.

## Proposals and withdrawal

An agent’s memory tools and automatic extraction from a compacted conversation create **proposals**. They become eligible for recall only after explicit acceptance. Editing a proposal does not accept it, and editing a withdrawn memory does not restore it.

Automatic extraction produces individual candidates with a citation to the original message. The server checks the message version, exact quoted text and access before storing evidence. A user message and an assistant message retain distinct provenance; a verified citation verifies where the text came from, not whether the statement is true.

Compaction records its extraction request durably with the conversation cursor. Failed extraction is retried with bounded backoff, and repeated candidates do not create repeated proposals. A rejected candidate with unchanged source and content remains rejected. Short conversations that never compact are not automatically captured by this trigger; use **Remember** or the agent’s memory tool when appropriate.

Withdrawal excludes a memory from future governed recall. Previously published copies are independent and must be withdrawn separately if that is the intended outcome. Historical messages are not rewritten: removing a memory is different from erasing every occurrence of the same information from its original sources.

Memory content is background data. It cannot grant an agent permissions, authorize an external action or override the product’s instruction hierarchy. Access checks, lifecycle checks and revision checks remain server-side.

## Classify and consolidate

The chosen bot prepares bounded Choice criteria from its current Instructions. You approve those exact criteria in the conversation. The connected judgment model supplies labels; the conversational model coordinates the tools and explains results. Jev does not generate the criteria or run the bot by itself.

A classification remains a suggestion until you validate or correct it in the same conversation. The bot submits your answers for one-time confirmation; it cannot approve its own suggestion. Changing the source memory or the bot Instructions invalidates stale classification and review requests. Different bots can retain separate methods and annotations.

The current format supports up to eight independent criteria with nineteen choices each, plus no match. No Tolaria, OKF or OKR taxonomy is imposed. These management tools are available only in the selected bot's private, user-triggered conversation. Groups, messaging channels, scheduled runs and delegated helpers do not receive them.

For consolidation, the bot reads two to eight active memories from one collection, proposes a Markdown synthesis and asks for confirmation. Acceptance can explicitly replace the sources or keep them. Replaced sources remain in history. Changed or unavailable sources invalidate dependent syntheses for governed recall. OKF import through the bot also creates a proposal: metadata claiming approval, authorship or permissions remains inert.

Hosted classification, embeddings and automatic clustering are optional. The existing learning mechanism is contextual reuse of approved examples, not weight training.

## Existing installations

The database migration preserves existing Markdown documents and their revisions. Legacy user documents remain personal; they do not become shared merely because the old settings screen called them “Shared documents”. Documents without verifiable human activation enter the proposal list for review.

Canonical recall works locally without a hosted memory provider. Recall from the existing Serenity and Supermemory connections is paused: their current integration does not resolve results to canonical document revisions. Connection settings are retained, but connecting a provider does not enable semantic recall. Existing provider-only facts are not automatically imported or treated as approved knowledge. Keep a separate provider export when available and review material before adding it to the library.

Back up the database before a deployment migration and deploy the API and workers together. Do not keep an older worker running alongside the new memory lifecycle: it can still use the old automatic write path. A rollback of application binaries alone does not reverse the migration or restore old memory behavior safely.

## Deployment sequence

1. Pause incoming runs and stop old workers after their current jobs finish. Preserve pending jobs for the upgraded worker; do not let the old and new memory writers overlap.
2. Back up the database. Apply the versioned migrations once through the deployment migration runner.
3. Compare document and revision counts with the backup. Existing IDs, Markdown bodies and revision numbers must remain unchanged; the migration must not create shared publications from personal documents.
4. Start the upgraded API and workers together. Verify one personal memory and one shared publication using separate test identities, then resume incoming runs.
5. Read inherited proposals in the library and ask the selected bot to review them. Provider-only data is outside the migration coverage; recover it through a provider export when available and import only reviewed content.

For a controlled rollout or incident, an operator can set `Space.memoryRecallEnabled` to `false` for the affected space. The library and its revision history remain available, but canonical reads and searches return no recall candidates. Runs revalidate dependencies before subsequent model calls and tools; disabling recall does not retract text already sent. Set the field back to `true` after verification. Do not roll back to an older worker or restore direct provider injection as a fallback.

The automatic safety checks cover governed memory and its recorded dependencies. They do not erase an independently present fact from an authorized source message. No deterministic test suite proves that every model will ignore every malicious instruction embedded in text.

The current interface and validation evidence are described in the [dedicated memory bot plan](plans/2026-09-24-dedicated-memory-bot.md). Native touch and screen-reader behavior still require device verification.

## Connect a judgment model

On web, desktop and mobile, open **Settings → Models → Judgment model**. A Space owner can enter and test a Jev API key, keep `jev-latest` or choose a versioned model. The connection test uses synthetic content. Under **Data sharing**, allow memory analysis before the bot uses a hosted judgment model; this is separate from connecting a key. The existing encrypted Jev connection is retained after migration, so it does not need to be entered again.

The connection is a shared model capability, independent of the bot's method and the memory storage provider. Keys remain encrypted server-side and never return to the UI. Failed verification preserves the previous connection. Disconnecting makes Jev unavailable; it does not silently switch a method to another model. If no connection is configured when criteria are prepared, the local reviewed-examples adapter is used. Re-preparing after a connection change requires confirmation.

Classification sends the selected memory, up to eight authorized neighbors and up to four eligible reviewed examples after the acting user's data-sharing consent. Preparation happens in the bot conversation using its normal model and approved Instructions. Jev receives the bounded classification request separately. Saving a method does not schedule autonomous classification or automatically accept captured memories.

## Learn from classification reviews

Each validation preserves the original prediction and the corrected values. Future classifications can reuse relevant examples immediately, scoped to the same **bot, method version and collection**. Method changes create a new version; feedback from the previous version remains in history and does not silently transfer.

Methods and new corrections stay private to the selected bot and reviewer. Existing historical annotations remain readable. The same bot can manage personal and Space memories; another bot's private collection remains excluded.

Ask the bot to stop learning from a review to revoke it after confirmation. The annotation and audit remain. Changed content, invalid or withdrawn sources, expired validity, revoked membership and unavailable neighbors make examples ineligible too. Revoking a newer correction does not reactivate an older correction it replaced.

Examples and source text remain untrusted data. Questions and allowed answers come exclusively from the prepared method, with bounds and validation at the provider boundary. This contains the effects of hostile text but is not a guarantee that a model can never be influenced semantically by it. Neither labels nor model confidence grant permissions or establish factual truth.

The local provider reuses eligible, non-conflicting human labels only for identical content and otherwise abstains. Jev receives bounded reviewed examples as contextual guidance; this does not retrain its weights. API validity, browser tests and database tests do not establish semantic accuracy. Evaluate each method against independently annotated examples before claiming an accuracy gain.

See the [current implementation plan and screen references](plans/2026-09-24-dedicated-memory-bot.md).
