# 2. Memory manifest revalidated before model calls

## Context

A run can last many steps, and memory changes during it: a memory is withdrawn, edited or its access changes. Compacted summaries and earlier bot replies can also carry memory text into later turns long after the memory itself is gone.

## Decision

Every run records a manifest of the memory revisions (document, revision, access version) it was given. Before each model call and each tool call, the run checks the manifest against current authorized memory; any mismatch stops the run. Summaries and bot replies keep their own manifests and are replayed only while those still validate. A missing or malformed manifest fails closed. Runs recorded before the memory library are backfilled with an empty manifest, meaning no governed memory dependency.

## Consequences

- Withdrawing a memory takes effect at the next model or tool call, and stale summaries are dropped rather than replayed.
- Text already sent to a model is not retracted.
- Any edit to a recalled memory interrupts runs that used it, a deliberate trade of availability for correctness.
- Facts present independently in an authorized source message are not covered.
