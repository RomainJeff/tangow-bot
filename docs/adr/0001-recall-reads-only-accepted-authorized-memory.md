# 1. Recall reads only accepted, authorized memory

## Context

Memories come from people (Remember), bots (memory tools), automatic extraction and imports. Text from bots, extraction and imports can be wrong or hostile, and earlier hosted memory providers injected their results directly into runs without resolving them to a canonical revision or checking access.

## Decision

Recall reads only from the canonical library, and only memories that are active and that the run's actor and bot may read at that moment. Everything not captured by a person directly starts as a proposal and is recalled only after explicit human acceptance. Hosted providers (Serenity, Supermemory) are paused for both recall and saving until they can resolve results to canonical revisions. `Space.memoryRecallEnabled` turns recall off per Space without touching the library.

## Consequences

- A poisoned or mistaken bot or extraction output cannot reach a later run without a person accepting it.
- Recall works offline with no hosted provider; semantic recall waits for an adapter that maps to canonical revisions.
- Users must review proposals, so short conversations that never compact are not captured automatically.
- Memory content stays data: it never grants permissions or authorizes actions.
