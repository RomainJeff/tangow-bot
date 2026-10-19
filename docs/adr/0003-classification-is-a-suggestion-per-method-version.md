# 3. Classification is a suggestion per method version

## Context

People want to sort memories by their own categories, and different bots may sort the same memory differently. A fixed global taxonomy did not fit, and a model's label or confidence is not proof of anything.

## Decision

A bot classifies with a method prepared from its Instructions and approved by a person. Methods are immutable versions. A classification is an annotation tied to bot, method version and memory revision; it stays a suggestion until a person validates or corrects it, and it never changes content, access or lifecycle. Feedback is reused only for the same bot, method version and collection. Classification runs on the Space's decision provider, or a local exact-match adapter when none is connected.

## Consequences

- Two bots can annotate one memory independently without conflict.
- Changing Instructions or the memory invalidates pending runs and reviews; old feedback stays in history but does not transfer to a new version.
- Revoking feedback stops its reuse but keeps the audit.
- No weight training: learning is bounded contextual reuse of reviewed examples.
