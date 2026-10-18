# P0 SDK handoff

**Verdict: SDK composition passes; migration is blocked on the proposed performance gate.** The synthetic comparison exceeds 1.20×. Product performance remains inconclusive. This document does not authorize a product runtime switch, deployment, or final feature merge.

## Integrated references

- Application baseline and merged #188 contract: `a34028112d43c75cb6e13d0b121d843015696de0`.
- Infrastructure documentation and portable-probe reference: `09f242991ada8fdab2a9ce7a1fa847671d511874`.
- No predecessor ticket is required by P0. The final feature base also includes main `6cd65548ed4988a6429c3ec52404463b5d376d0f` and its startup repair [#201](https://github.com/RomainJeff/rakazo-bot/pull/201).
- Application slices target `feature/pi-e2b-workers`. The feature PR targets `main` and remains draft until P6.
- SDK package: `@earendil-works/pi-coding-agent`, exactly `1.3.0`, in `packages/adapters/package.json` and `pnpm-lock.yaml`. Core, AI, and telemetry remain at `1.3.0`.

The published infrastructure reference has no `AGENTS.md` or `CLAUDE.md`. Its agent-start guide, ticket registry, canonical implementation plan, architecture, and portable SDK probes were inspected. The probes are historical evidence, separate from the executions recorded here. Their OAuth limitation remains unresolved.

## Ownership retained

`PiAgentRuntime` remains the product engine. Rakazo owns authorization, durable steering, the canonical SessionLog, public messages, factual run recaps, and compaction policy. A Pi session is an in-memory execution projection. It is not the canonical log and does not provide durable recovery by itself.

The baseline import of `DEFAULT_COMPACTION_SETTINGS` from `pi-agent-core` fails TypeScript checking and Node ESM module linking because that package does not export the symbol. The API and worker import this executor at startup. Vitest's transformed import does not reproduce that module-link failure.

The startup repair landed independently in main through [#201](https://github.com/RomainJeff/rakazo-bot/pull/201). It makes the executor use the policy already defined in `history-compaction.ts`, with the same token reserves. The migration branch merged main to consume it. The duplicate #202 was closed without merging. This P0 slice changes neither executor nor compaction policy and keeps the proof SDK in devDependencies.

## Design choice

Three independent designs compared a proof-only session fixture, an unused production wrapper, and a CLI subprocess. An independent reviewer selected the proof-only fixture. It exercises the public SDK without committing a second production runtime contract before the migration.

The selected design returns messages from the SDK's safe-point hook. The synthesis also includes poisoned-resource canaries, unchanged-directory checks, and real simulated provider protocols. A production wrapper would have no product caller in P0. A subprocess would hide the session hooks that this ticket must exercise. Package-version inventory tests were rejected because the lockfile already records the dependency and a copied list would not prove runtime behavior. No design candidate was dropped.

The implementation and its verification can still invalidate this design. In particular, an abort race or mixed tool batch can require a blocking SDK verdict.

## Public SDK signatures

The installed SDK declares these entry points. The executable proof is the authority for their composition and observed limits.

```ts
createAgentSession(options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult>;
SessionManager.inMemory(cwd?: string, options?: NewSessionOptions, entries?: FileEntry[]): SessionManager;
SessionManager.appendMessage(message: Message | CustomMessage | BashExecutionMessage): string;
SessionManager.appendCompaction(summary: string, firstKeptEntryId: string | null, tokensBefore: number): string;
ModelRuntime.create(options?: CreateModelRuntimeOptions): Promise<ModelRuntime>;
AgentSession.abort(): Promise<void>;
AgentSession.waitForIdle(): Promise<void>;
```

`SessionManager.inMemory` accepts a fresh transcript or restored session entries. Its session file is absent. A summary belongs to the imported execution projection and does not replace the public factual recap.

The package root does not export `AuthStorage`, even though its internal module declares `AuthStorage.inMemory`. The proof injects Rakazo's existing `PiRuntimeCredentialStore` through the public `ModelRuntime.create({ credentials })` option. Successors must not import an unexported SDK file to obtain an auth store.

The SDK installs its own `session.agent.prepareNextTurnWithContext` wrapper. A host hook must call that wrapper and preserve its returned context, messages, model, and thinking level. The selected proof appends claimed user messages to the returned `messages`. It does not place durable claims in the SDK steering queue. The SDK emits those messages through `message_end` and persists them in its SessionManager.

The parent claims steering. Helper sessions have independent managers and do not claim from the parent's store. The hook prepares an actual next assistant turn. It is not a callback after every text-only final response.

The SDK's own compaction check precedes the appended steering messages. P0 disables automatic SDK compaction. P2 and P3 must account for those messages in Rakazo's context budget rather than assume the SDK hook counted them.

`session.agent.subscribe` awaits asynchronous listeners as part of run settlement. `session.subscribe` declares a void listener. A future adapter must explicitly prove the settlement of its asynchronous event translation.

## Checkpoint inventory

No checkpoint contract is removed in P0.

- `AgentRunRequest.resumeFromCheckpoint` is populated by the executor and consumed by `ScriptedAgentRuntime` for `takeover` and `takeover-skipped`.
- The `Run.checkpoint` database field also supports takeover, choice continuation, reconciliation, and fenced run claims. `takeover-resume.ts` owns several of these transitions.
- The generic `AgentRuntimeEvent` checkpoint variant has no producer or executor handler in the baseline. Its removal would be a separate cleanup after its consumers are rechecked.
- Sandbox workspace checkpoints are independent of the agent runtime checkpoint vocabulary.
- API and worker composition roots still instantiate `ScriptedAgentRuntime` for the scripted configuration. Deterministic product journeys still use that runtime.

## Verification and limits

The [baseline receipt](evidence/P0/baseline.json) records the runs before the SDK proof. It includes the pre-existing typecheck failure and the interrupted integration baseline. Neither is a passing result.

An approval-capable tool must mark its batch as sequential before effects start. The executable proof sets `executionMode: "sequential"` on that tool, which makes the SDK serialize the whole mixed batch. The tool calls `ctx.abort()` when approval becomes pending. A negative control shows that `terminate: true` alone permits a sibling and another inference. Another shows that an asynchronous approval in a parallel batch can allow a later sibling to start before the approval result arrives.

Sequential abort preserves the completed tool results and the approval result. It can leave later assistant calls without results. P2 must represent those calls as pending or uncertain in the canonical log and reconstruct a valid next-run projection. P0 does not synthesize successful results or replay these effects.

Returning claimed messages from the safe-point hook preserves them through an in-process abort racing the claim. This does not make the claim and the controller's durable event log one crash-atomic transaction. That delivery and recovery contract belongs to P2.

P0 does not prove E2B volume isolation, NFS security, Firecracker boundaries, a recovery executor, or model quality. No real provider credentials, production databases, shared-host deployments, or infrastructure restarts are part of this work. Offline protocol tests cannot resolve the existing MCP OAuth browser redirect and credential-persistence gap.

There is no user interface change in P0. The [desktop](evidence/P0/media/recap-desktop.png) and [390×844 phone](evidence/P0/media/recap-phone.png) captures are preservation evidence for #188, from `interactive-run-memory.spec.ts`. That scenario signs up through the real API, then uses a synthetic thread projection. It confirms hidden private memory and a retired pending question, not SDK integration. Native iOS was not captured because no mobile code changed. Electron E2E remains a CI-only check on a maintainer's machine.

## Inputs for successor tickets

P1 and I1 consume the SDK verdict and its limitations before freezing worker and volume contracts. P2 must preserve cancellation, the real end of a run, durable claim delivery, and partial tool-batch state. P3 must retain the existing private-text, runtime-notice, model-connection, usage, and trace translation when it switches the runtime.

A failed SDK gate requires a blocking verdict and an estimate. It does not authorize a fork or a guessed replacement contract.

## Reproduce the contracts

Use Node 24 and pnpm 9.15.0 from a clean checkout of this slice. Docker is required only for PostgreSQL and web harnesses. No vendor credentials are required.

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm check
pnpm lint
pnpm test:pi
pnpm exec vitest run packages/adapters/src/pi-runtime.test.ts packages/adapters/src/pi-runtime-cancellation.test.ts packages/adapters/src/executor-approval-pi.test.ts packages/adapters/src/executor-secret-pi.test.ts
pnpm exec vitest run packages/adapters/src/pi-runtime-tool-dispatch.test.ts packages/adapters/src/pi-runtime-models.test.ts
pnpm test:integration
pnpm test:e2e:affected
pnpm bench:pi-sdk --trials 30 --out pi-sdk-benchmark.json
```

The SDK examples are executable behavioral tests. Use these direct commands for one contract.

| Contract | Source example | Direct test filter |
| --- | --- | --- |
| Create with injected history, tools, prompt and key; no implicit files | `createProofSession` in `pi-sdk-proof-support.ts` | `pnpm exec vitest run packages/adapters/src/pi-sdk-proof.test.ts -t 'sends only'` |
| Restore summary plus kept messages | `SessionManager.appendCompaction` and imported entries | `pnpm exec vitest run packages/adapters/src/pi-sdk-proof.test.ts -t 'restores a compacted'` |
| Claim steering at the next safe point while helper and tool run | `chainDurableSteering` | `pnpm exec vitest run packages/adapters/src/pi-sdk-proof.test.ts -t 'delivers durable steering'` |
| Sequential approval stops siblings and inference | `ctx.abort()` from an approval tool | `pnpm exec vitest run packages/adapters/src/pi-sdk-lifecycle.test.ts -t 'sequential approval'` |
| Inference abort settles and closes its stream | held loopback stream | `pnpm exec vitest run packages/adapters/src/pi-sdk-lifecycle.test.ts -t 'aborts a held inference'` |

The lifecycle suite also covers the claim/abort race, late steering, parent/helper abort, asynchronous agent listeners, isolated concurrent sessions, and negative approval controls. `pnpm test:pi` runs both suites.

## Preservation versus migration

The new tests use the real SDK and real HTTP/SSE parsers with synthetic OpenAI and Anthropic endpoints. They establish composability. They do not exercise a new production adapter, because P0 adds none.

The existing product suites retain model resolution, cancellation, approval, secret handling, private final text, runtime notices and trace translation. `pi-runtime-tool-dispatch.test.ts` owns the private-text/runtime-notice and nested tool-span assertions; `pi-runtime-models.test.ts` owns connection routing. `pi-run-trace.test.ts` and `run-trace.test.ts` cover trace timing and spans. PostgreSQL runs include real executor and canonical-log journeys. Keep these suites when P3 replaces the engine; passing SDK event tests alone cannot establish those host-owned policies.

## Replacement cost and decision

Source inventory at the frozen base finds 2,221 lines in `pi-runtime.ts`. Its two Agent construction blocks account for 57 lines (31 and 26), which are candidates for replacement, not a measured net deletion. Tool dispatch, authorization, recaps, private/public projection, model routing and trace translation remain host responsibilities. P0 removes no product loop or checkpoints.

Estimate, not a delivery commitment: allow 3–5 engineering days for the runtime adapter, event translation and approval/steering/abort parity after P2 contracts are stable, plus 1–2 days to profile and resolve the performance gate. Worker transport, infrastructure isolation, file migration, MCP OAuth and recovery are separate successor work. Do not start a fork to absorb an unresolved gate.

## Final results and performance gate

The tested code commit is `014e9a631281b9227152ae03a9ba7ac2da2755dd`. The [verification receipt](evidence/P0/verification.json) binds its source and lockfile hashes to commands, individual gates, media and cleanup. The later evidence commit changes documentation and captures only. The [reproduction sheet](evidence/P0/reproduce.txt) contains the CLI commands and observed test summary.

Workspace typechecks pass across 23 tasks. Lint passes with the baseline 47 warnings and one informational diagnostic. `test:pi` passes 30 tests, including 19 SDK cases. The four issue-specified suites pass 35 tests; extra product-preservation suites pass 59 tests with overlapping cancellation coverage; trace suites pass 14. PostgreSQL integration passes 159 tests across 22 files. The first SDK integration attempt was invalidated by a concurrent prerequisite edit; its two timeouts are not counted as a valid regression result. The stable rerun is the recorded pass.

The required affected selector chose the full web suite because no readable impact map exists. It reports **211 passed and 11 failed**. Ten stale specs still wait for `run.finished` in the main thread after #188 moved it into an interactive run session. One expects the removed `quote-selection` button. The same failures occur on the repaired-base checkout and on this SDK checkout. This attribution is based on source and both executions; an unmodified frozen-base E2E pass is impossible because that base cannot start its executor. The full web suite remains red. The recap privacy/reload scenario passes and supplies the linked images.

The [30-pair benchmark receipt](evidence/P0/benchmark.json) preserves every sample, median, range, error count and actual provider path. The primary metric constructs **two fresh instances**, each performs a tool call and a final text response, and both settle. The timed work awaits all four responses and uses both final answers. Literal wire transcripts, credentials, schemas and both tool effects are asserted. The medians are **3.089 ms Agent → 6.334 ms SDK**, ratio **2.051×**, above the proposed **1.20×** budget. No noise floor, latency injection or threshold change conceals this result.

Diagnostic instance construction is 0.064 → 0.892 ms. The first tool/text run is 1.238 → 2.202 ms. A second turn on the same instance is 0.901 → 1.153 ms; it is not a replacement for the fresh-run metric. Held-stream abort settles below 5 seconds in every sample. Fresh-process module imports are measured separately at 83.154 ms for the core/AI/provider set and 229.238 ms for the SDK root. Those module sets differ in capability, so they have no comparative gate and do not represent VM boot.

The host had 18 logical CPUs and other system work remained active. A/B and B/A pairs alternate, and all task-owned application tests finished before timing began. A separate CPU profile sampled module compilation, catalog merging, session projection and loadout work, but also imports and child-process waits. It does not establish the primary steady-state limiter. Raw profiles remain outside git because they contain local paths. Provider registrations and stream options differ, and the benchmark excludes the full executor and model latency. Therefore **the product ratio and causal explanation remain inconclusive**, while the measured synthetic budget failure remains explicit.

P1/I1 may consume the API constraints as proof inputs; they must not treat this as approval to switch the engine. Before P3 adoption, profile equivalent model/provider paths and the real executor, preserve per-run isolation, then repeat at least 30 alternating trials. Resolve the budget or obtain an explicit product decision accepting its measured cost. The estimate above includes investigation, not a promised SDK optimization or authorization to fork.

No E2B VM, volume, deployment or real credential was used. PostgreSQL harnesses and loopback fixtures cleaned up, and final reconciliation found no running task-owned test processes or Docker containers. CI and automated PR review are separate delivery gates; local receipts do not claim they have completed.
