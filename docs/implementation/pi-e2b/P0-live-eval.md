# P0 real-model comparison

Results are pending. The evaluator source is frozen at `79cccff84` before the primary run. The earlier microbenchmark and its failed diagnostic budget remain in [P0-handoff.md](P0-handoff.md).

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
