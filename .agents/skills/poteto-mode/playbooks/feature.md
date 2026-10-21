### Feature

**You own the design. Plan, review, verify.** Delegate implementation. Stay in the lead.

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Name the artifact or decision each unit needs to start, verify and land. Run only start prerequisites before dispatching that unit.
   - **Independent workstreams.** Record the per-unit decomposition from **principle-separate-before-serializing-shared-state**, reusing the scoped card or architecture rationale. State what proceeds while another unit is busy or awaiting review.
   - **Shared mutable state.** Before dispatch, resolve overlapping write paths and runtime resources with separate targets or a named writer and integration order, per that principle. Assign an integration owner.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Delegate code-writing to a subagent using your configured feature model (default `sonnet`) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria). When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the **arena** skill instead so the runners surface the alternatives and the cross-judge guards the pick. Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation. No "standing by" reply that waits on a nested agent. Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Keep small, ordered commits and follow the repository's branch synchronization rules. Stack follow-ups only when their code dependencies require it.
   Use **principle-sequence-verifiable-units** within each dependent sequence; verify and commit independent units concurrently.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.

Code-coupled work (one feature, one migration) has one owner for coherence and integration, with the checkpoint inline. Ownership does not reserve every affected file for the duration of the feature. That owner dispatches units as their start prerequisites are satisfied and integrates verified results while other units continue. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries. Spawn a fresh owner rather than chaining interrupts.

Every worker brief names allowed and excluded write paths, the agreed contracts, start / verify / land dependencies, and isolated or serialized runtime resources. If work requires changing a shared contract or another unit's paths, report the proposed change and affected units to the feature owner before making that change; continue independent work. Put unrelated discoveries in follow-ups. A blocked review or human decision holds only its dependents.

**Reply:** what you built, what you chose and why, the throughput checkpoint, open decisions. Tables for design alternatives.
