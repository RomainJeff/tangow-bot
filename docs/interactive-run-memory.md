# Interactive run memory

Interactive work keeps its execution trace in a child session. The conversation retains user messages, messages sent through `message_user`, and an internal structured recap with references to the run.

A later run searches archived results by run ID and query. The search returns bounded excerpts with entry IDs and timestamps. It must enforce conversation access, inference audiences, and the active history chain. It must not expose private reasoning or replay actions.

The run archive and durable semantic memory serve different purposes. Both remain available. Compaction preserves a way to discover archived run IDs.

The history budget candidate is 60,000 tokens, constrained by the model's usable context after fixed instructions, tool schemas, memory, and reply reserves. Performance and follow-up quality must be evaluated before claiming an improvement.

## Delivery

1. Add authorized, bounded run search before reducing replay.
2. Isolate interactive sessions and persist internal recaps without changing steering, approvals, cancellation, or crash recovery.
3. Project recaps and references, evaluate the budget, and verify follow-ups across supported surfaces.

Tool discovery optimization is independent and requires evidence of redundant work before a change.

## Visibility

Only `message_user` publishes conversational text to the user. Final model text and recap persistence do not publish messages. Existing approval and question interactions keep their own UI contracts.

## Status

Implementation is in progress. This document records the target behavior, not a claim that it is available.
