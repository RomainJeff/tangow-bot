# Classification through bots

Status: the implementation below was tested mechanically but its UI did not match the bot-centric product requirement. Superseded by [the dedicated-bot correction](2026-09-24-dedicated-memory-bot.md). Supersedes the fixed classification form and learning scope in [the earlier feedback plan](2026-09-24-memory-classification-feedback.md).

## Product decision

A memory has content, provenance, access and lifecycle. A bot applies a user-authored method to that memory. Its classification is an attributed annotation, not a universal property that every bot must accept.

Users write their method in Markdown, including categories, definitions, examples and exclusions. They do not need to author a schema. A connected conversational model prepares bounded criteria once when the method changes. Jev can then apply those criteria without a generative call on every memory. A local provider reuses exact, eligible reviewed examples and otherwise abstains. Jev is a judgment model, not a conversational model or a method compiler.

Each method has immutable versions. Every run and human correction records the bot, version, source revision, prediction and reviewed values. Feedback is reusable only for that bot, version and collection. Updating a method starts a new feedback scope. Two bots can annotate the same memory independently.

## Screens and actions

The earlier [M07 visual](../research/memory-okf-prototype.html) is the baseline being replaced: its fixed Type/Nature/Relations form is obsolete. M03 library navigation, M05 Markdown editing and M06 preview remain applicable. The browser tests capture the implemented replacement screens, rather than treating the earlier prototype as the new specification.

| Screen | Entry and actions | Browser screenshot |
| --- | --- | --- |
| Bot method | Bot settings → Classification; write/preview Markdown, select judgment model, permit collections, optionally share the capability, save | [Method](../research/memory-bot-methods/method.png) |
| Connection | Bot method → Connection; configure or reuse the shared judgment connection | [Connection](../research/memory-bot-methods/connection.png) |
| Review | Memory → Details → choose bot → Review classification; correct generated criteria and validate | [Review](../research/memory-bot-methods/review.png) |
| Conversation review | Ask the configured bot to classify a memory; open its review link, correct and validate that exact suggestion | [Exact suggestion](../research/memory-bot-methods/review-link.png) |
| Attribution | Memory → Details; see bot, method version and validated labels; stop using a correction for learning | [Annotations](../research/memory-bot-methods/annotations.png) |

These captures come from local browser tests with synthetic fixtures. They are references for the implemented screens, not evidence of semantic model accuracy or CI execution.

Web and Electron share these screens. Mobile uses the same contracts with native selection sheets and switches. Advanced connection and prepared-criteria details are disclosed only on demand. The editor no longer asks for fixed taxonomy or OKR fields; validity remains a separate lifecycle control. Existing classification metadata stays readable and exportable.

## Delivery boundaries

1. **Contracts, persistence and authorization.** Add immutable bot methods and nullable attribution to existing classification records. Keep historical rows and the encrypted judgment connection. Move connection configuration under model capabilities. Enforce bot ownership for preparation and explicit capability sharing for team use.
2. **Preparation and inference.** Validate prepared criteria strictly, forbid executable output and disable all tools in the preparation runtime. Derive Jev questions and permissible answers exclusively from the versioned method. Keep content and examples in untrusted data fields, with bounded input and output. A bot can invoke only its own current method through `classify_memory`; API and worker share the same classification service and consent checks.
3. **Review and learning.** Save annotations without modifying memory content, qualification, status or revision. Validate against the immutable run. Recheck access and freshness around external calls; exclude stale, revoked and incompatible examples. Sharing a method does not automatically share individual corrections.
4. **UI and retirement.** Replace the global classifier form and hardcoded review fields with the bot method and dynamic criteria. Retire the old public RPC entry points and fixed Jev adapter. Preserve legacy data and compatibility readers.
5. **Verification and local deployment.** Exercise dynamic criteria, invalid answers, method changes, multiple bots, private/team access, stale content and revoked corrections. Back up the local database before additive migrations and rebuild the existing Docker deployment without resetting its data.

## Acceptance evidence

- No built-in taxonomy is required to configure or apply a method.
- The method preparer receives only the explicitly supplied method and has no tool access.
- Source text cannot introduce question keys or answer values outside the prepared method; this boundary does not guarantee semantic immunity to prompt injection.
- Reviews cannot overwrite a different bot's annotation or activate a proposed memory.
- Conversation review links load the recorded run without another model call; tools cannot validate their own suggestions.
- Old method feedback, private corrections, revoked examples and inaccessible sources cannot train a different scope.
- A disabled or concurrently edited method cannot accept a stale run as current feedback.
- Existing memories, revisions, legacy classifications and encrypted connection remain intact after migration.

## Scope limits

The first executable method format supports up to eight independent criteria with up to nineteen named choices each and an explicit no-match value. Open-ended extraction, automatic graph editing and autonomous reclassification schedules are separate capabilities. Human-reviewed examples guide later inference; no model weights are retrained by this change. Semantic accuracy must be evaluated on the user's methods and data rather than inferred from typed output or confidence.

The conversation tool is available in the configured bot's private, user-triggered conversation. Groups, messaging channels, scheduled runs and delegated helpers do not receive this capability. These contexts require their own authorization and review design before expansion.

The old fixed-taxonomy engine, library entry points, contracts and dedicated tests have been removed. Bot-method and memory-lifecycle integration tests cover the current workflow and preservation of legacy rows. Historical classifications remain stored and their memory metadata remains readable through details, revisions and OKF exports.

Private agent collections retain the existing same-bot boundary. A dedicated classifier can apply its method to permitted personal and Space memories, but cannot read another bot's private collection. An attempted expansion of this boundary was rejected by automatic approval review and was not applied.

## Validation

After retiring the obsolete internals, 12 bot-classification and OKF unit tests, 11 bot-method PostgreSQL tests and 7 memory-lifecycle PostgreSQL tests pass again. TypeScript checks pass for web, mobile, API, worker and affected packages. The local Docker image was rebuilt with the retired code removed.

- 126 focused offline unit tests pass for preparation, typed judgments, consent, navigation and executor behavior.
- 11 PostgreSQL scenarios pass for bot methods, isolated feedback, stale runs, exact review links, the shared classification service and legacy row preservation; 7 existing memory lifecycle scenarios pass.
- 10 browser journeys pass for Markdown editing, method creation, consent refusal, review, revocation, exact-run links, import/consolidation and the judgment connection. The compiler and provider probes use synthetic offline fixtures.
- TypeScript checks pass for web, mobile, API, worker and affected shared packages. The full mobile check additionally reports existing Expo patch-version freshness requirements; native-device interaction was not exercised. No local Electron end-to-end suite was run.
- The local Docker image built and the additive migration applied after a database backup. API, worker and web run the same image; document/revision counts and the encrypted judgment connection are unchanged. The existing browser session displays the new method editor and retained connected status.

These checks establish workflow and boundary behavior. No live-provider accuracy benchmark or model-weight training was performed.
