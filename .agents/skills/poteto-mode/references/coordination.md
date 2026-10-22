# Coordination through the launching orchestrator

Apply when several delegated tasks run concurrently. The parent that launched them owns coordination. Workers report cross-task effects to that parent; it decides and relays the outcome to affected workers. Keep routine local findings for the final report. Deliberately competing candidates may explore different designs in isolation; coordinate their shared inputs and resources without forcing them to converge before selection.

## Before dispatch

Each brief names the parent, the available reporting channel, owned write paths, agreed contracts or artifact revisions where relevant, and start / verify / land dependencies. Use existing SHAs or artifact identifiers; no new revision system is needed. Resolve shared writes and runtime resources before launch. For remote workers, include these instructions in the brief rather than assuming access to this file. Reuse the existing checkpoint or program records; a small group needs no new coordination system.

## Worker events

Report as soon as evidence reveals an undeclared dependency, a required shared-contract or cross-scope change, an invalidated shared assumption, a file/resource conflict, or a blocker to the assigned result. Do not wait for task completion when intermediate reporting is available.

Send a short event containing:

- Finding and evidence, including the contract or artifact revision examined.
- Potentially affected tasks, paths or contracts; mark uncertainty explicitly.
- Proposed action or decision needed.
- Work paused and independent work that can continue.

Pause the affected work before making the shared change. Continue independent in-scope work. Do not negotiate a separate direction with siblings or expand scope unilaterally.

Use the host's actual communication capabilities. If intermediate reporting or instruction updates are unavailable, return a partial `BLOCKED` result with completed artifacts and evidence. The parent starts a new delegated task with the consolidated decision and brief. Do not invent messaging tools or treat a message as a completed instruction update.

## Parent decisions and acknowledgement

On an event, inspect the evidence, identify affected units, choose the direction and writer, and update their briefs. Sub-coordinators escalate cross-track decisions to their parent. Relay one decision reference, what it supersedes, affected work and verification to repeat. Record the decision and outstanding acknowledgements in the existing checkpoint or program records. Routine technical coordination stays with the parent; existing human approval requirements still apply.

For a decision that invalidates active work, obtain acknowledgement from each affected worker before authorizing the shared change or resuming that dependent work. An acknowledgement names the decision and confirms the affected work is held or revised. Sending an update, silence or a generic status is not acknowledgement. If a worker cannot acknowledge, keep the affected change blocked; use the host's hold/cancel capability and confirm it stopped, or wait for its terminal result, then reconcile through a fresh task. Independent work continues.

## Results and integration

Handle events and completions as they arrive through supported notifications or at phase boundaries; do not poll on a timer. Finish an in-progress atomic operation safely, then resolve invalidations before further affected dispatch or integration. Recompute ready tasks after each result.

Check every result against the current brief and contract revision. An old-revision `PASS` is not current verification. Reconcile useful artifacts and repeat invalidated checks before integration. Account for completed, blocked, failed and cancelled workers; a missing result is a gap, not success.
