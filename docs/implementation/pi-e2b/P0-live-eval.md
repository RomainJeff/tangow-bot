# P0 real-model comparison

The first pilot finds no consistent latency or quality improvement on its two short tasks. Every variant passes 11 of 12 tasks. The evaluator source was frozen at `79cccff84` before that pilot. The earlier microbenchmark and its failed diagnostic budget remain in [P0-handoff.md](P0-handoff.md).

The question is whether task completion, latency and token use change when the session engine or file tools change. The pilot uses real OpenAI Responses requests to `gpt-6-luna`, with medium reasoning, a 4,096-token response limit, a 40-tool budget and a 180-second task deadline.

The three variants are the actual `PiAgentRuntime`, an SDK `AgentSession` with the same tool names and schemas, and an SDK session with native read/write/edit definitions. All variants use the same task instructions and fresh in-memory project files. The current-runtime variant retains its event translation and silent-turn continuation. The SDK variants are prototypes of the session integration, not the production worker adapter.

Two seeded tasks exercise financial reconciliation across CSV files and minimal repairs to a service configuration. Deterministic graders inspect the final artifacts independently. Configuration repairs fail if they remove valid dependencies or change unrelated files, even when all planted faults were fixed. The model can run a format/invariant check but cannot read the reference answers.

Six trials per task and variant produce 36 planned runs. Every trial uses the same seed across variants. All six execution-order permutations rotate across the trials. Requests run serially after the local web suite finishes. There are no artificial waits to reach a desired task duration. A prior one-trial wiring calibration used reasoning off and is excluded from the primary comparison.

Run locally with an existing private credential in the process environment:

```sh
pnpm eval:pi-sdk --live --trials 6 --max-usd 3 --output test-report/pi-live-eval/report.json
```

Without `--live`, the command writes a not-run report and makes no model requests. `--connection` accepts a private `models/connect` JSON file instead. Do not commit credentials or raw artifacts. Catalog cost estimates are not billing receipts. An incomplete run reports unknown cost and stops subsequent runs. A completed run with a failed grade remains an observed task failure and does not stop the pilot.

Report success counts before timing comparisons. Compare successful durations and paired trials where both variants succeeded. Retain failures, ranges, tool errors, token usage and cost estimates. Process CPU measures local process work, not remote model compute. Small samples, remote service variation, in-memory file IO and absent shell/browser/executor integration limit any adoption claim. The native SDK path resolver may inspect host path metadata; overridden operations keep file contents in memory.


## Short-task results

The [summary receipt](evidence/P0/live-primary-summary.json) binds the source hashes, controls and paired comparisons. All 36 runs completed, with 33 correct artifacts and no tool errors, run errors or deadline hits. The CLI exits with code 1 because some artifacts fail grading. Re-grading all saved artifacts with the frozen grader reproduces every verdict. Estimated total cost is $0.02735, from catalog token pricing.

For reconciliation, successful-run medians are 10.65 seconds for the current runtime, 9.41 seconds for the SDK with the same tools, and 11.30 seconds for native SDK file tools. Success counts are 5/6, 5/6 and 6/6. The [individual samples](evidence/P0/live-primary-reconcile.json) retain all runs and their ranges.

For configuration repair, successful-run medians are 9.06, 10.74 and 9.69 seconds, respectively. Success counts are 6/6, 6/6 and 5/6. The [individual samples](evidence/P0/live-primary-config-repair.json) retain all runs and their ranges.

On paired seeds where both variants pass, median SDK-to-current wall ratios range from 0.83 to 1.22 across the two comparisons and tasks. Every comparison's range crosses 1.0. These observations do not establish a stable speedup or regression. The two reconciliation failures miss one unpaid order on the same seed. The native SDK configuration failure also removes a valid dependency after repairing all planted faults.

Observed durations span 6.23 to 27.71 seconds. These tasks therefore do not establish behavior on one-to-two-minute workloads. Local process CPU accounts for less than 3% of each run's wall time. This is consistent with waiting on remote model and network work, but it does not measure remote inference or prove a fixed SDK overhead. Unrelated host background work was elevated. The balanced ordering reduces drift bias without removing service or host noise.

## Longer workload

A separate follow-up expands the configuration work into a release across multiple deployment units. It retains the same policy and strict preservation grading. It adds real files and repairs, without an artificial duration floor. Its results will remain separate from the frozen short-task pilot.
