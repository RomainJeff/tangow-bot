# Memory management through a chosen bot

Supersedes the UI and entry-point design in `2026-09-24-bot-memory-methods.md`.

## Product contract

- An ordinary bot has no Classification settings section.
- The user chooses a bot through the existing Skills controls and enables Memory management for that bot. The skill starts unassigned. No separate bot type, automatic global activation or memory-specific configuration form is introduced.
- The user's pattern belongs in the bot's ordinary Instructions. The bot prepares typed criteria from those instructions; the user approves the exact preparation in the conversation. Jev uses the shared judgment connection, configured under Models. Existing memories and reviews are retained.
- Search, reading, classification, corrections, import, consolidation and lifecycle operations are tools available to that bot in its direct conversation. Personal and Space visibility remain bounded by the existing library; another bot's private collection remains inaccessible.
- The library is for reading: search, Markdown rendering, provenance and history. No edit, import, export, consolidation, classification dropdown, validation, share or withdrawal controls remain there.
- Content changes and classification feedback use the existing exact human approval cards. The bot cannot self-approve; automatic approval rules cannot silently validate these tools. A source revision or method change invalidates stale review inputs.

## Implemented

The web/mobile library and ordinary bot settings now follow the contract above. The optional skill is assigned through the existing Skills controls. Search/read/classify tools and guarded preparation/review/change tools are registered with the executor, filtered by skill assignment and private user-triggered context, and checked again on invocation. All management tools are excluded from delegated helpers.

Writes use the existing exact-request approval/replay mechanism. These requests never offer blanket approval and do not pass through automatic review. Denied or revoked operations do not execute. Classification returns to the bot conversation. Current Instructions are checked both before inference and inside memory transactions, so stale prepared criteria and pending reviews cannot be used after an Instructions edit. Existing annotations and revision history remain available.

The shared judgment connection is under Models. Data-sharing permission can be granted or withdrawn there on web/desktop; mobile links to its existing native permission screen. Missing permission returns an actionable error and does not call the provider. Connecting a key and authorizing memory analysis are separate actions.

## Verification

- 215 focused unit tests pass across 17 suites, covering executor selection, exact approval replay, denial, revocation, adapters and existing executor behavior.
- 14 PostgreSQL method/tool scenarios pass, including bot isolation, revision checks, idempotency, historical feedback and changed Instructions.
- 3 offline Pi product journeys pass. The new journey uses the real executor and database: prepare criteria, wait for approval, classify, wait for correction approval, reject the model's altered replay payload, and use the approved correction on another memory. Neither criteria nor feedback exist before approval.
- 4 browser journeys pass: message capture/readback, reading-only library, explicit skill assignment/removal, and model connection with permission grant/withdrawal.
- Web, API, worker, adapters, memory, testkit and mobile TypeScript checks pass. Native touch and screen-reader interactions have not been tested on a device.

The local Docker API, worker and web were updated together after a database backup. A dedicated synthetic demo bot was assigned the skill through the UI, its method was put in ordinary Instructions, and preparation was approved in conversation. The configured Jev connection returned Protocole for an interview preparation protocol. A conversational validation was approved and persisted; the library displayed the bot's annotation with no editing controls. Clicking the annotation returned to the bot conversation. This one live case verifies wiring, not classification accuracy across a corpus.

The automatic approval review initially blocked executor integration; implementation continued only after explicit user authorization. No blocked command was bypassed.

## Visible copy

The skill is named **Memory management**, with the catalog description **Manage memory in conversation using your instructions.** The assignment uses the existing Skills switch. **Judgment model** names the collapsed shared model section. **Data sharing**, **Allow memory analysis** and **Withdraw permission** appear only within the configured connection, where the user needs to decide whether to send memory content to that provider. The existing shared disclosure describes the data involved. Confirmation cards identify the operation and retain its complete payload for review; they remain a plain structured preview, not a specialized editor.

## Screen evidence

Local test fixtures: [ordinary bot settings](../research/memory-dedicated-bot/ordinary-bot-settings.png), [assigned skill](../research/memory-dedicated-bot/memory-skill-assigned.png), [read-only memory](../research/memory-dedicated-bot/memory-read-only.png), and [judgment connection with data sharing](../research/memory-dedicated-bot/memory-classifier-connected.png). The browser tests produce these artifacts for CI too. These saved captures use synthetic fixtures and are not claimed as CI runs.
