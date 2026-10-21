---
name: principle-laziness-protocol
description: "Apply when refactoring, evaluating diff size, or tempted to add abstractions, layers, or signal threading. Bias toward deletion and the smallest change that solves the problem."
disable-model-invocation: true
---

# Laziness Protocol

Aim for the most result with the least code and complexity.

- **Prefer deletion.** When asked to refactor or improve, look for removals before additions.
- **Maintain a flat call hierarchy.** Avoid deep call chains. A rich interface that hides substantial work is not a deep call chain. If answering a question requires tracing through more than 3 files or layers, flatten it.
- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag.
- **Minimize the diff.** Make the smallest change that solves the problem. Fewer lines beat "elegant" boilerplate.
- **Question the threading.** If a task asks you to pass a new signal through types, schemas, pipelines, or similar layers, stop and look for a more direct path.
- **Sweat the small leaks.** Remove tiny pass-throughs, representation leaks, and duplicated choices before they spread. Small leaks compound into permanent coordination costs.

**The test:** If a human developer would find the code exhausting to maintain, it is a bad solution.

## Independent plan review

Once a complete implementation plan, architecture proposal or ticket breakdown exists, dispatch `founding-engineer` before presenting or executing it. Supply the plan path or full text, the original request, explicit constraints and relevant code or evidence. Use `.claude/agents/founding-engineer.md` for Claude or `.codex/agents/founding-engineer.toml` for Codex. If the named role is not loaded yet, dispatch a general-purpose agent with the shared Markdown instructions. The reviewer remains read-only and works inline without further delegation.

Return its findings to the user alongside the plan. The plan owner records each recommendation as accepted, rejected or open, with a reason, and owns any resulting edits. Advice is not a veto or a request for additional human approval; existing approval requirements still apply.

Review the complete plan once across nested planning skills; reuse that review when scope and architecture are unchanged. Repeat only after a material change to scope or architecture. Formatting, progress updates and the review report itself do not trigger another review. If delegation is unavailable or fails, report that the independent review was not completed and why; do not present self-review as an independent verdict.
