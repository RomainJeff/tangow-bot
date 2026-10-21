---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N parallel isolated workers. They may cover separate slices, race the same brief, or mix both. The parent coordinates discoveries during the run, aggregates results, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Coordinate
4. Aggregate
5. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers, not the concurrency limit.
4. Pick the worker model from the `swarm workers` line in the pstack model config (`/setup-pstack`), `~/.claude/pstack-models.md` (Cursor: `~/.cursor/rules/pstack-models.mdc`). If the config or that line is missing, use `sonnet`. For `inherit` (or `auto`, `inherit-parent`), omit `model` so the workers run on the parent model. If the Agent tool rejects a model, use the default and say so. For a model race, name each arm's model up front.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Use the host's supported delegation transport, resolving model and isolation through its available capabilities. With the Agent tool, spawn all N workers in one message with `subagent_type: general-purpose`, `isolation: "worktree"`, `run_in_background: true`, and the step 4 model, left unset for `inherit`. Use equivalent supported options on other hosts. Drop `isolation` only when workers neither write nor build. (Cursor: `Task` tool with `environment: "cloud"`.)

When a worker must start from a non-default branch, name the branch in its brief and have it check that branch out in its worktree.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

Apply [the coordination protocol](../poteto-mode/references/coordination.md). Each brief names the launching parent, available reporting channel and agreed contract or artifact revisions. Include the protocol text when a worker cannot access this checkout.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Coordinate

Process cross-task discoveries before affected work advances, using the protocol's decision and acknowledgement loop. Independent workers continue. If the host supports terminal results only, a blocked worker returns partial evidence for a fresh, updated delegation. Handle completions as they arrive and start newly ready units without waiting for every worker. Keep intentional race candidates independent until selection.

## Phase D: Aggregate

Read the terminal results and reconcile them against the current brief and contract revisions before accepting them. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase E: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
