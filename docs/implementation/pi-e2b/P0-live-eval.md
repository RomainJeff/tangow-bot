# P0 real-model comparison

> Removed. The evaluator (`pnpm eval:pi-sdk`, `packages/adapters/src/pi-live-eval*.ts`) and the in-process `PiAgentRuntime` it compared were deleted when every run moved to workers ([#317](https://github.com/RomainJeff/rakazo-bot/issues/317)). This page records the pilot's results; its commands no longer run.

The real-model pilots find no consistent latency or quality improvement on these workloads. Every variant passes 11 of 12 short tasks and all six longer tasks. The evaluator source was frozen at `79cccff84` before that pilot. The earlier microbenchmark and its failed diagnostic budget remain in [P0-handoff.md](P0-handoff.md).

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

The separate `config-fleet` case expands the configuration work into a release across 24 independent deployment units. It contains 193 files and 72 planted faults, producing 96 initial checker findings because each invalid dependency also creates a cycle. Each unit retains the original policy and strict preservation grader. Unit seeds are `seed * 100 + index`, with zero-based indices. The release manifest must retain its meaning and unexpected files fail grading.

This increases reading and editing volume, rather than introducing a new kind of reasoning. The source task, deadlines and budgets were frozen at `4561b93cc24534e7adc795882d6b81cf5aa9d8de` before the run. The long pilot ran six trials per variant with a 512-call cap and a 300-second deadline. These are maximums, not a target duration. Reasoning and response limits remain medium and 4,096 tokens for every variant. The larger tool budget also sets the current runtime's existing per-turn limit for this comparison. No product default changes.

```sh
pnpm eval:pi-sdk --live --case config-fleet --trials 6 --max-tool-calls 512 --timeout-ms 300000 --max-usd 3 --output test-report/pi-live-eval/long.json
```

The default invocation still selects only the two short cases with a 40-call budget. Both default and long-case dry runs create a not-run report without model calls. After adding the fleet and configurable budget, 17 evaluator tests and 15 shared file-operation tests pass and workspace typechecking passes all 23 tasks. The cost guard can stop a rotation partway through. All recorded outcomes remain visible, but paired speed comparisons use only complete matching seeds with successful results. The long results below remain separate from the short pilot.


## Long-workload results

All 18 runs completed and passed. Every saved artifact also matches an independent policy-repair implementation. Each run fixes all 72 faults and preserves every other configuration value. No run errors, deadline hits or cost-stop guards occurred. Two tool calls failed in the native SDK variant, and both runs recovered and passed. The evaluator records those errors as counts, so their tool names and causes are unknown.

The [long summary receipt](evidence/P0/live-long-summary.json) includes full source hashes, task hashes, controls, raw-sample links, token usage, costs and paired comparisons. Each variant has six successful runs:

- The [current runtime](evidence/P0/live-long-current-runtime.json) has a wall median of 70.56 seconds, ranging from 57.58 to 73.98 seconds. Median tool calls are 174 and model turns are 14.
- The [SDK with the same tools](evidence/P0/live-long-sdk-same-tools.json) has a wall median of 63.24 seconds, ranging from 56.45 to 82.68 seconds. Median tool calls are 152.5 and model turns are 15.
- The [SDK with native file tools](evidence/P0/live-long-sdk-native-files.json) has a wall median of 66.24 seconds, ranging from 56.37 to 96.65 seconds. Median tool calls are 131 and model turns are 17.

The median of the six same-seed SDK-to-current time ratios is 0.978 for the same-tool variant, ranging from 0.800 to 1.126. It is 0.982 for native file tools, ranging from 0.768 to 1.408. These paired comparisons avoid inferring a speedup from the ratio of two unrelated medians. The variation is larger than the paired median difference. Six pairs do not establish a stable speedup or regression.

The native tools require fewer calls in median, but more model turns, and do not establish a latency or cost advantage here. Estimated total costs across each variant's six runs are $0.03762, $0.03420 and $0.03971, respectively. The full long pilot costs an estimated $0.11153. Most reported context tokens are cache reads, so those totals also reflect actual provider caching. They are catalog estimates, not invoices.

Local process CPU totals 7.3 seconds against 1,237.5 seconds of wall time, about 0.6%. Waiting on the model and network is the likely limiter, inferred from those counters. Remote model compute was not profiled, and unrelated host activity remained uncontrolled. The 56-to-97-second task durations are observed, with no injected waits.

All variants reach a perfect task score, so this workload cannot distinguish their quality. It tests sustained reading and editing volume, with synthetic files in memory. It does not establish harder reasoning, coding ability, worker integration or production readiness. Together, the pilots show that the historical 2.051x microbenchmark ratio is not an observed 2x full-task slowdown. They neither erase that diagnostic result nor prove that migration improves task outcomes.
