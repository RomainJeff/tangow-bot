---
name: setup-pstack
description: Configure which models pstack uses per role and at what budget. Detects your available models and writes a model config that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write the pstack model config, which sets pstack's model per role. In Claude Code it is `~/.claude/pstack-models.md`, a plain Markdown file skills read explicitly. In Cursor it is `~/.cursor/rules/pstack-models.mdc`, an always-applied rule.

## Steps

### 1. Detect available models

In Claude Code the detected set is the `model` enum of the `Agent` tool: `opus`, `sonnet`, `haiku`, `fable`. The alias `inherit` is always valid even though it is not a detected model. It means the role runs on the parent session model (omit Agent `model`). Accept `inherit-parent` and `auto` as synonyms and write them as `inherit`.

In Cursor, enumerate the model slugs you can pass to a `Task` subagent in this session. If Cursor also exposes a models API or CLI that lists the user's entitled models, prefer it. The aliases `inherit-parent` and `auto` are always valid there.

If you cannot detect any, ask the user to paste the models they have access to. Never write a real model you have not confirmed is available.

### 2. Load current state

The default role-to-model mapping is the shape shown in step 5 below. If the config file already exists, read it and treat its `# budget` line and its role values as the current choices. Otherwise start from those defaults. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer AskUserQuestion over free text. Offer these three options with these exact labels, and name the current budget when the config records one.

- `max — table defaults`
- `balanced — opus only for judgment`
- `economy — sonnet and haiku`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by model, list, or alias (`inherit`). `max` leaves every role as in that table. `balanced` turns every `opus` into `sonnet`, panel entries included, except in `judgment and prose`, `hardest tasks`, `how explainer`, `why synthesizer`, and `reflect judgment, divergent, synthesizer`. `fable` stays. `economy` turns every `opus` and `fable` into `sonnet` and every `sonnet` into `haiku`. Panels keep their length. If the result is not a detected model, mark the role as needing a choice. `inherit` does not change.

Cursor has per-slug reasoning effort instead of tiers. There, offer `unlimited — keep max`, `large — xhigh reasoning`, `medium — high reasoning`, and `small — medium reasoning`. The last three set the effort token of every real slug to `xhigh`, `high`, or `medium` on the ladder `max` > `xhigh` > `high` > `medium` > `low`. The effort token is the last token, or the one before a trailing `fast`. If the result is not a detected slug, use the same family's detected slug with the highest effort at or below the target.

**(c) Show the roles and confirm.** Show every role with its model, marking any real model not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit` as the options. Prefer AskUserQuestion over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real model written must be in the detected set. `inherit` (and in Cursor `inherit-parent` and `auto`) always passes. If a chosen real model is not available, stop and ask again.

### 5. Write the config

Write the config file with a `# budget` line with the chosen label and one line per role, using the same labels poteto-mode uses. Overwrite the whole file so re-runs stay idempotent. In Claude Code, write `~/.claude/pstack-models.md` with no frontmatter. Shape:

```
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# `inherit` as a value: the role runs on the parent session model (omit Agent `model`). Alias entries in a panel list still count toward its fan-out.
# budget: max
feature, refactoring: sonnet
bug-fix: sonnet
perf-issue: sonnet
hillclimb: sonnet
judgment and prose: opus
hardest tasks: opus
how explorer: sonnet
how explainer: opus
why investigators: sonnet
why synthesizer: opus
reflect tooling: fable
reflect judgment, divergent, synthesizer: opus
arena runners: opus, fable, sonnet
arena cross-judge pool: opus, fable, sonnet
swarm workers: sonnet
architect runners: opus, fable, sonnet
interrogate reviewers: opus, fable, sonnet
```

In Cursor, write `~/.cursor/rules/pstack-models.mdc` with this frontmatter above the same lines, `inherit-parent` or `auto` as the alias, and `# budget: unlimited (max)` style budget lines.

```
---
description: pstack per-role model choices (overrides skill defaults)
alwaysApply: true
---
```

Cursor default slugs map from the Claude table as `opus` to `claude-opus-5-5-max`, `sonnet` to `grok-4.7-xhigh-fast`, and `fable` to `gpt-5.6-sol-max`.

### 6. Confirm

Tell the user the config was written and that it applies to new sessions. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill` (resolves wherever pstack is installed: workspace, user, or plugin). On no, move on without pushing.
