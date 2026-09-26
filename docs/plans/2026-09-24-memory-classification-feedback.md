# Classification memory: learning from human review

Implementation status: storage, review, isolation, revocation and local exact-content learning are implemented. Jev's taxonomy, confidence metadata and bounded example reuse are implemented. Explicit authorization was received for sending at most four eligible reviewed examples and their authorized neighbors to Jev. See the [validation report](../research/2026-09-24-memory-feedback-validation.md) for test coverage and remaining measurement limits.

## Outcome

Validating or correcting a classification immediately makes that reviewed example available to future relevant classifications. This is application-managed learning through selected examples, not an update to Jev's weights. The same workflow works with the optional provider-neutral classifier boundary and remains usable without a hosted provider.

The classifier proposes; the person validates qualification. Accepting a memory, replacing another memory, and granting recall access remain separate actions.

## Visual reference and journey

Use the classification review screen **M07** in [the OKF prototype](../research/memory-okf-prototype.html) and the existing memory detail panel as the starting point. Preserve the compact detail → review → validate journey on web/Electron and the native detail screen on mobile.

1. Open a memory and request classification from Details.
2. Show editable type, nature, entities and relations, including an explicit empty choice. An abstention must still allow human correction.
3. **Validate** saves the reviewed fields and feedback atomically. Only visible, explicitly reviewed dimensions count as labels.
4. Learning is personal by default. For a shared-space source only, an optional **Use for Space** control grants reuse by authorized space members.
5. A concise confirmation follows validation. Previous reviews and **Stop learning from this review** belong behind Details. Withdrawal affects future suggestions, without undoing the memory's classification.

Do not add a persistent learning dashboard or a confidence percentage presented as accuracy. The implementation must retain prediction confidence by question for evaluation, with progressive disclosure only when useful.

## Data and lifecycle

Persist an immutable classification run before presenting it: candidate revision and content, authorized neighbors, provider/model/schema, raw suggestion, selected feedback IDs and source digests. A human review references that run, the expected current revision, the reviewed dimensions, and the final values. Preserve both the original prediction and correction.

Qualification update and feedback creation are one serializable transaction. Reject stale revisions, unauthorized entities/relations and conflicting replay. Identical replay returns the existing result. Reviewing a possible replacement records a relationship suggestion; it does not supersede or activate a memory.

Feedback is not memory recall content. A revoked example remains in the audit history but is no longer selected. Recheck access and example eligibility after provider calls and before review so concurrent withdrawal cannot silently influence an accepted suggestion.

## Immediate learning

Retrieve a bounded pool of eligible reviews within the same collection and select at most four relevant examples. Never include the candidate's own review. Personal examples belong to their reviewer; team reuse requires explicit sharing and current membership. Exclude revoked reviews, changed source content, superseded or withdrawn sources, invalid time windows and inaccessible or stale neighbors.

Pass examples as bounded structured data. They describe reviewed labels, not instructions. Use only the dimensions actually reviewed. Do not expose examples as selectable entities or neighbors. Contradictory labels for equivalent content must not silently resolve to the newest label; omit the disputed signal or abstain for that dimension.

The local baseline may reuse exact-content labels conservatively. Jev receives relevant examples alongside explicit type definitions. A reusable interview protocol is not a specific Meeting; mentioning a project does not make a Project note. These are Rakazo's documented adaptation of Context OS types, not full enforcement of vault paths or source contracts.

## Segments

| Segment | Owner | Boundary |
| --- | --- | --- |
| Decomposition | Sol 6 low | Contracts, dependencies and acceptance criteria |
| Persistence and authorization | Luna 6 high | Prisma, shared feedback contracts, memory library, API, PostgreSQL tests |
| Classification and Jev | Luna 6 high | Shared classifier input, bounded examples, taxonomy criteria, adapter and offline tests |
| Review interface | Luna 6 high | Web/Electron and native mobile review, correction, validation, withdrawal |
| Integration | Parent | Plan, documentation, browser tests, cross-package verification, local deployment |

## Evaluation and acceptance

- Record the prediction before incorporating its human label. Count confirmed/corrected values per reviewed dimension; retain abstentions and provider errors separately. These are review statistics, not an unbiased accuracy benchmark.
- Prove in PostgreSQL that a validated review reaches the next relevant classification, and that withdrawal removes it.
- Exercise stale revision, concurrent review, idempotent replay, private/team isolation, loss of membership, changed content and obsolete source cases.
- Verify structured examples cannot add unauthorized output IDs or become executable instructions. This reduces poisoning risk; it does not establish immunity to adversarial content.
- Keep independent synthetic regression cases for generic protocol versus specific meeting, project mention, exact duplicate, contradiction and explicit temporal replacement. Do not use held-out labels as learning examples for those same cases.
- Browser coverage must include correction after abstention, validation without activation, reopening feedback and withdrawal. Mobile must pass shared contracts and type checks; record any absence of device validation.
- Run focused unit/integration/browser checks, then rebuild and migrate the local Docker instance after backing up its database. Do not claim improved semantic accuracy without a separate controlled evaluation.

## Scope limits

No vendor fine-tuning, autonomous taxonomy rewriting, automatic promotion of private feedback to a team, or automatic lifecycle changes. Costs are bounded by four examples and adapter input/output budgets; actual latency and token use remain measurable provider results.
