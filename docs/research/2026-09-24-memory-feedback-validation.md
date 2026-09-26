# Classification feedback validation

Implementation follows [the feedback plan](../plans/2026-09-24-memory-classification-feedback.md) and the M07 review journey in [the OKF prototype](memory-okf-prototype.html).

## Implemented

- Immutable classification runs and atomic qualification review, with original prediction, reviewed dimensions and final values retained separately.
- Immediate, bounded selection of relevant feedback in the same collection. Local classification reuses labels for identical normalized content; it does not generalize semantically.
- Personal feedback by default, explicit sharing for Space sources, current authorization checks, revocation and exclusion of changed or obsolete examples.
- Latest same-person correction takes precedence by dimension; withdrawing it does not reactivate an older annotation. Conflicting labels in the bounded candidate pool are excluded before choosing at most four examples.
- Web/Electron and mobile review controls, including correction after abstention, explicit empty values, compact history and withdrawal. Empty controls are hidden and do not create labels.
- Jev taxonomy criteria distinguish reusable procedures from concrete meetings and project mentions from project records. Confidence is retained per judgment.
- Jev receives at most four eligible reviewed examples as structured state after explicit authorization. Only reviewed dimensions are serialized, historical source IDs are omitted, and example/neighbor text is bounded within the overall request budget.

## Verified

| Verification | Result |
| --- | --- |
| Classifier, Jev adapter and draft unit tests | 22 passed |
| Connection, secrets and consent unit tests | 17 passed |
| Feedback PostgreSQL journeys | 8 passed |
| Existing memory library PostgreSQL journeys | 7 passed |
| Browser classification journeys | 3 passed |
| API, memory, web, mobile and testkit type checks | Passed |
| Prisma generation and migration on an isolated database | Passed |
| Local Docker build, migration and health | Passed |

The feedback database tests cover next-call reuse, immutable original predictions, atomic replay, conflicting replay, stale candidate and neighbor revisions, private/team separation, unauthorized references, lost membership, modified/expired/superseded sources, withdrawal during inference, conflicts before the four-example limit, and newer corrections without resurrection after withdrawal.

The three browser journeys verify review without proposal activation, correction of an abstention followed by reopening and withdrawal, and rejection of a concurrent edit without feedback. Test screenshots are attached by the browser suite under `memory-M07-classification-review`, `memory-M07-feedback-correction`, and `memory-M07-feedback-withdrawn`. They are local verification artifacts, not evidence of a CI run.

The local deployment was backed up before its additive migration. Existing document and revision counts were preserved. The already-open memory remained accessible in the app after reload. No connected-provider inference or real-memory review was submitted during this deployment check.

## Jev example activation

Explicit authorization for the additional sharing was received. The adapter now sends up to four reviewed examples and their authorized neighbor text. Additional adapter tests verify the cap, truncation, omission of unreviewed fields and historical IDs, conflict projection, and rejection of an invented output reference. Shared consent disclosures and the web prompt describe the added examples. Existing connection settings and consent enforcement remain in place.

Two live calls using synthetic French interview-protocol text succeeded on `jev-1.13.0`. The request without an example used 1,248 input tokens and took 574 ms; the request with one synthetic reviewed example used 1,351 input tokens and took 527 ms. Both used 191 output tokens. The smoke asserted the serialized example count and that only type/nature labels were present; no actual saved memory was used as test input.

Both responses classified the held-out protocol as `Document` / `procedure`, despite the illustrative example carrying `Note` / `procedure`. This confirms successful contextual example transmission and valid responses, but **does not demonstrate improved classification accuracy or automatic obedience to one correction**. The model's weights are unchanged; a representative annotated evaluation remains necessary to measure generalization and choose retrieval settings.

No live before/after accuracy claim is made. Offline adapter tests verify request criteria and response handling, not the semantic correctness of the hosted model. Native mobile behavior was type-checked but not exercised on a device; desktop uses the web screen, and its focus-stealing Electron suite was not run locally.
