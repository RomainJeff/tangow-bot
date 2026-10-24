# P5 durable native work handoff

**Status: the offline contract, the live lanes and the measurements are in.** All six native lanes passed on E2B, including the two new ones. The token measurements (S2) found no scenario where a persistent native session would save the 15 % that would justify building one.

P5 makes the work of a harness with its own loop durable while the attempt runs. Before P5, the guest sent one transcript per agent at the very end of the attempt. A VM that died, a cancel, a timeout or a supersession lost every native bash the bot had already run, and the next attempt could run the same command again.

## Integrated references

- Issue: [#199](https://github.com/RomainJeff/rakazo-bot/issues/199). The plan that replaced its pre-native items moved compaction inside an attempt to the harness, and resumption to a new attempt projected from canonical history. P5 has no Pi checkpoint.
- S1, incremental transcripts: [#306](https://github.com/RomainJeff/rakazo-bot/pull/306), merged into `feature/pi-e2b-workers` at `455f4d743`.
- S2, measurements: [#310](https://github.com/RomainJeff/rakazo-bot/pull/310). The receipts are under [evidence/P5](evidence/P5/).
- S3, live lanes and this handoff: [#309](https://github.com/RomainJeff/rakazo-bot/pull/309). The live lanes ran at `30231d4bdb5cf55636e78d46b62275451d23665e`.
- Predecessor: the [P4 handoff](P4-handoff.md). The controller still answers every model call through the relay, and the effect journal still owns controller tools.

## Delta transcript

The guest reports its native session through the existing `transcript` body of a `worker.event` frame. No frame type was added. Each frame carries the messages that ended since the previous frame:

```json
{
  "type": "transcript",
  "agent": "root",
  "dialect": "pi-ai",
  "messages": [
    {
      "role": "assistant",
      "content": [{ "type": "toolCall", "id": "call-1", "name": "bash", "arguments": { "command": "ls" } }]
    }
  ]
}
```

`GuestBodySchema` in `packages/adapter-kit/src/worker-protocol.ts` is strict. `messages` holds at most 4,096 entries, each with a `role`. The `systemPrompt` field is gone, because nothing read it. `agent` names a helper's session and defaults to `root`.

### What the guest sends

`apps/agent-run-worker/src/harness/pi-native.ts` reports from Pi hooks that the loop awaits:

| Pi hook | Message sent | Effect |
| --- | --- | --- |
| `message_end` of an assistant message | The message, with controller tool names mapped back | A tool call is in the controller's log before Pi runs the tool. |
| `message_end` of a `toolResult` | The result | The result reaches the log as soon as the tool ends. |
| `session_compact` | `{ role: "compactionSummary", summary, tokensBefore }` | The summary is logged as `harness.summary`. |

Each frame waits for the controller's `recorded` decision. If a report fails, the guest aborts the session instead of running on without a log. The `finally` block no longer sends a batched transcript.

### What the controller does with it

`transcriptIngest` in `packages/adapters/src/runtime-worker/transcript.ts` keeps one reducer per agent for the attempt. The session inbox already delivers frames once and in order, so frames carry no sequence number and no final flag. Each frame yields the steps it adds:

| Step | Logged by the executor as | Notes |
| --- | --- | --- |
| `call` | `tool.call` with `native: true` | Only tools in the harness's manifest from `nativeToolsForHarness`. |
| `result` | `tool.result` | Paired by `callId` with the latest open call of that id. |
| `controller` | Nothing | The controller already logged its own call and answer. A result the harness claims for it is only counted in `unverifiedCalls`. |
| `summary` | `harness.summary` | No history reads it. A later attempt replays canonical history. |
| `text` | Nothing during the attempt | The final reply is computed from all reported steps at `done`. |

`logHarnessTranscript` in `packages/adapters/src/executor.ts` appends the entries only while the attempt owns its run. Entries land in the order the harness made them, along the session chain that history replays. The D9 back-dating is deleted.

### Refusals

| Report | Refusal | Proof |
| --- | --- | --- |
| More responses and summaries than model requests the controller relayed for the agent | `budget` | `runtime-worker-transcript.test.ts`, "is refused for a response no relayed model request produced" |
| More tool results than calls the agent reported | `budget` | Same file, "is refused for a result of no reported call" |
| A native call under an id a controller call already holds | `invalid` | Same file, "is refused when it claims an id the controller already runs a call under" |
| A controller `tool.call` under an id the harness already reported as its own | `invalid` | `runtime-worker-native-transcript.test.ts`, "refuses a harness that reports its own call under a controller call's id" |
| A report from a helper that already closed | `invalid` | `runtime-worker-transcript.test.ts`, "is refused from a helper that already finished" |
| A report after the attempt lost its run | revoked | `runtime-worker-transcript.test.ts`, "is refused from an attempt that lost its run" |

One call id belongs to one side for the whole attempt. The session log pairs a result with the latest open call of its id, so a shared id would let a guest answer a controller call with a forged result.

## Native call states

A native call moves through these states in the run's session log:

```mermaid
stateDiagram-v2
  [*] --> called: assistant message_end ingested
  called --> answered: toolResult ingested
  called --> open: attempt ends first
  open --> interrupted: a later attempt of the run takes the fence
  open --> open: run cancelled, no later attempt
  answered --> [*]
  interrupted --> [*]
```

- **called.** A `tool.call` with `native: true` exists and has no result.
- **answered.** The harness reported a result.
- **open.** The attempt ended without a result: VM death, timeout, cancel, supersession or controller stop.
- **interrupted.** `closeInterruptedNativeCalls` ran when a later attempt of the same run claimed the run (`claimedRun.leaseFence > 0`). It appended an error result: "The bash call was interrupted, so its outcome is unknown. It was not replayed; check the state before retrying." It closes only calls marked `native`, so a controller tool that shares a native tool's name stays with the effect journal. A second pass finds nothing open and appends nothing.

`projectInferenceTurns` in `packages/core/src/session-log/project-inference.ts` drops every `tool.call` without a result from the projected history. Without the interrupted result, the next attempt would not see the call at all and could run it again.

Reports are accepted by attempt state as follows:

| Attempt state | Report |
| --- | --- |
| Owns the fence and is running | Ingested and logged. |
| Paused on an approval and still owns the fence | Ingested and logged. |
| Started stopping (cancel, supersession, timeout, controller stop, loop guard) | Revoked. |
| Lost the fence | Revoked. |

## Crash, effect, approval and steering matrix

| Event | Run log and next attempt | Offline proof | Live proof |
| --- | --- | --- | --- |
| Worker VM dies during a native bash | The call is logged before bash starts. The next attempt closes it as interrupted, sees that result and does not replay the command. | `runtime-worker-native-transcript.test.ts`, "shows the next attempt a native call whose guest died during it as unknown, and never runs it again" | `native-kill-bash`, [P5 receipt](evidence/P5/lanes.json) |
| E2B kills the VM at its timeout during a native bash | Same as above. The attempt ends released with its writer lease free. | Same test | `g-timeout`, replayed in the [P5 receipt](evidence/P5/lanes.json) |
| User cancel during a native bash | Native work finished before the cancel stays in the log. The cut call stays without a result. No later attempt takes the run. | "keeps the native work done before a cancel, and the call it cut, without running it again" | `native-cancel`, [P5 receipt](evidence/P5/lanes.json) |
| Another attempt supersedes the run | The new attempt closes every open native call of the earlier one before it reads history. | `executor-history.test.ts`, "closes only a harness's own call an earlier attempt cut, not a controller tool of its name" | None |
| Native and controller calls interleave | The log holds them in the order the harness made them. | "logs native and controller calls along the session in the order the harness made them"; `executor-history.test.ts`, "logs a native harness's own calls among the controller's as the attempt reports them" | None |
| Controller tool in flight when the attempt dies | The effect journal owns it. An approved effect runs once; an interrupted one is reported as unknown and not replayed. | `executor-effect-idempotency.test.ts`, `executor-approval-replay.test.ts` | `native-helper-approval`, replayed in the P5 receipt |
| Approval pending, then controller restart and concurrent resumes | One approved effect, released attempts. | `runtime-worker-approvals.test.ts`, "does not run the approved call again when the controller died while running it" | `native-helper-approval` and `native-compaction`, replayed in the P5 receipt |
| Pi compacts inside an attempt | `harness.summary` is logged. A later attempt replays canonical history, not the summary. | `runtime-worker-native.test.ts`, "compacts with Pi's own compaction, whose summary request goes through the relay" | `native-compaction`, replayed in the P5 receipt |
| Steering claimed by an attempt that dies before delivery | The retried attempt receives the message once. | "hands a retried attempt a message its dead attempt claimed, once" | None |
| Report in flight during a controller shutdown or loop-guard stop | The report is revoked and lost. The call stays open until a later attempt closes it as interrupted. | Known limit, no test | None |
| A transcript after a supersession or cancel | Revoked. The attempt no longer owns the run. | "is refused from an attempt that lost its run" | None |

Unless a file is named, the offline tests are in `packages/testkit/src/runtime-worker-native-transcript.test.ts`. They run real Pi through the real executor on PGlite with a local worker provider.

## Live lanes

S3 adds two lanes in `packages/testkit/src/worker-live/lane-native-interrupts.ts`, registered in `LANES`. Both use the local model protocol fixture, so they prove runtime and transport behavior, not model intelligence. Both read a marker file on the private volume from a second VM, so the marker outlives the worker VM.

**`native-kill-bash`.** A native bash appends one line to `p5-started`, then sleeps for 300 seconds. When the second VM sees the marker, the lane kills the worker VM with `Sandbox.kill`, outside the product's destroy path. It passes when:

- the run log holds only the call before the kill,
- the run is queued after the kill and completes on a second attempt,
- the second attempt's first model request contains the interrupted text,
- the log holds the call and its interrupted result, and no second bash,
- the marker holds exactly one line,
- both attempts end released, and the session's sweep finds no sandbox to kill and leaves no sandbox or volume.

**`native-cancel`.** A first native bash prints `done-ok`. A second appends the marker and sleeps. When the marker appears, the lane cancels the run with `cancelRunsInTransaction`, the database write the stop button makes. It then continues the run once more. It passes when:

- the run ends `cancelled`,
- the log holds the first call and its result, then the second call without a result,
- no model request follows the cancel, and the second continue takes no attempt,
- the marker holds exactly one line,
- the single attempt ends released, and the sweep leaves nothing.

The attempt sees the cancel at its next lease heartbeat, which runs every 60 seconds. Offline, the attempt stopped 60.6 and 59.8 seconds after the cancel in two runs. The sleep outlasts that window, so the cut call is still running when the attempt stops.

### Offline proof

Both lanes ran unchanged against a local stand-in for the E2B session. The stand-in runs the real `pi-native` guest on a `LocalWorkerProvider`, maps `Sandbox.kill` to that provider's destroy, and reads the volume from its directory. Both lanes passed. Two controls failed them as expected:

- With `closeInterruptedNativeCalls` disabled, `native-kill-bash` failed. The retried request did not show the interrupted result.
- With the guest's per-message report disabled, both lanes failed. The log held no call before the kill or the cancel.

The stand-in is not committed. It proves the lane logic and the controller contract, not E2B's kill, envd's stream loss or volume visibility across VMs.

### Live receipts

The [P5 receipt](evidence/P5/lanes.json) records one serialized batch of six lanes at source `30231d4bdb5cf55636e78d46b62275451d23665e`, with `pi-native`, the `i1-worker` and `i1-computer` templates and the local model protocol fixture. The guest bundle (SHA-256 `e4543af118f89472b4b723ba330d4975b9819311781e97329c5a6673254ef869`) was uploaded into each owned worker. The runner SHA-256 is `a84c72e7e760307a09fb5ed1cb1eebf617e70cd226ac243396f11a307a110d14`. [reproduce.txt](evidence/P5/reproduce.txt) gives the commands.

| Lane | Result | Seconds | What it showed |
| --- | --- | --- | --- |
| `native-kill-bash` | pass | 14.7 | Only the call was logged before the kill. The first continue ended "Run setup failed; retrying" and the run was queued. The second attempt saw the interrupted result, the marker held one line and both attempts ended released. |
| `native-cancel` | pass | 65.6 | The attempt stopped 56.7 seconds after the cancel, at its lease heartbeat. The log held the finished call and result, then the cut call without a result. A second continue changed nothing, and the marker held one line. |
| `g-timeout` | pass | 32.9 | Replayed because S1 changed its transcript path. |
| `native-helper-approval` | pass | 10.4 | Replayed. |
| `native-catalog` | pass | 20.3 | Replayed. |
| `native-compaction` | pass | 16.1 | Replayed. |

Every lane ended with zero owned sandboxes and volumes. An independent census after the batch listed no sandbox, running or paused, and no volume on the deployment. The remote scratch directory was removed.

Before this batch, the runner refused to start once and created nothing, because a paused sandbox from another session was on the deployment. The maintainer authorized its removal, and the batch then ran on an idle deployment.

## Measurements

The runner is `worker-live measure` (`packages/testkit/src/worker-live/measure.ts`). It drives the protocol of the decisions document through the production executor, worker routing, pi-native guest and model relay, and records every model request from the relay's `agent.worker.model_request` event. Each receipt carries a `method` block that defines every figure. `worker-live measure-summary --in <receipt> --out <receipt>` recomputes a receipt's summary from its raw per-request fields.

Models: OpenCode Go through the user's model connection, `glm-5.3-flash` and `gpt-6-luna`, resolved as the newest catalog matches of `glm-*-flash` and `gpt-*-luna` in pi-ai 1.3.0. `gpt-6-luna` replaced DeepSeek V4.1 Flash, which needs the workspace's Global region setting. The pair replaces the decisions document's "one explicit and one automatic provider" by maintainer choice.

| Receipt | Where | Trials per model | Timings |
| --- | --- | --- | --- |
| [token-cache-chain.json](evidence/P5/token-cache-chain.json) | local guests, gaps 10 s, 2 min, 6 min | 30, overlapped | not comparable |
| [token-cache-compaction.json](evidence/P5/token-cache-compaction.json) | local guests, forced `history.compact` | 30, overlapped | not comparable |
| [token-cache-approval.json](evidence/P5/token-cache-approval.json) | local guests, grants after 10 s and 6 min | 30, overlapped | not comparable |
| [token-cache-computer.json](evidence/P5/token-cache-computer.json) | E2B, validated private N13 computer candidate with desktop preparation | 30, serial | comparable |
| [token-cache-approval-serial.json](evidence/P5/token-cache-approval-serial.json) | E2B, no computer, grant after 10 s | 10, serial | comparable |

Overlapped runs only count tokens and cache. Every thread has its own controller, bot and thread, and a nonce in its tool catalog.

**Cache mode.** Both models are `automatic`. The mode is read from the requests and the provider's usage, not from the catalog. No captured request body carried `cache_control`. pi-ai 1.3.0 adds those markers only on `anthropic-messages` and on `openai-completions` models whose compat names the Anthropic format, and neither arm is one. GLM 5.3 Flash reports cache reads only. GPT-6 Luna reports reads and priced writes. Every request of both models carries the thread's session id in the `x-opencode-session` header, which Rakazo's OpenCode transport sets. Luna's requests also carry it as `prompt_cache_key`. Luna's cache is routed per session: every thread's first request read 0 and wrote the whole prompt. GLM still reused other threads' cache.

**Shared base.** Every bot sends the same harness base prompt and tool catalog, so cache reuse across threads is a real product saving. The receipt splits each cache read into reuse of that shared base and reuse of the thread's own prefix (`cacheReadReuse`).

- In the overlapped runs, no first request of any thread read past the shared base (`firstRequestsOverBase` 0 of 29 per model and scenario).
- GLM first requests read up to 4736 tokens against an estimated base of about 4618. That base assumes GLM renders the tool catalog before the messages. This is an inference, not confirmed: in request-body order the threads share only about 2.7k tokens.
- In chain, GLM read 497,784 shared-base tokens and 225,388 per-thread tokens. Luna read 680,362 and 457,021.
- The serial host approval receipt was captured before the tools' position was recorded, so its first requests are reported apart (`firstRequestsWithoutToolsAt`).

**Persistent session estimate.** The estimate replays each thread's root requests. A persistent session continues every attempt from the previous full prompt and answer, and grows within an attempt as the projection did. Screenshots of earlier turns stay as far as they were still in the previous request after the relay's image cap. They are never dropped at a run boundary. The previous prompt counts as cached whenever the projection read any cache, which is generous to the persistent session. Prices are the catalog list prices per million tokens. The formula is in each receipt's `method.persistentEstimate`.

| Scenario | GLM 5.3 Flash projection, persistent, saving | GPT-6 Luna projection, persistent, saving |
| --- | --- | --- |
| chain | $0.1441, $0.1449, -0.6 % | $0.0454, $0.0448, 1.4 % |
| compaction | $0.2131, $0.2117, 0.6 % | $0.1151, $0.1036, 10.1 % |
| approval | $0.1533, $0.1594, -3.9 % | $0.0525, $0.0536, -1.9 % |
| computer | $0.2001, $0.1949, 2.6 % | $0.0750, $0.0760, -1.2 % |

No scenario reaches 15 %, so no persistent arm is built. The highest saving is 10.1 %, for GPT-6 Luna across a forced compaction. In chained exchanges, the share of a turn's first request read from cache did not change with the gap for either model. GLM's median share was 0 at every gap, with a p95 near 0.97. Luna's was 0.945 at 10 s, 2 min and 6 min.

**Restore.** From the serial host approval run only. Restore spans from the grant persisted to the resumed attempt's first relayed model request, minus provisioning (worker provider ensure to guest hello). Provisioning is reported apart.

| Model | Restore p50, p95 | Provisioning p50, p95 |
| --- | --- | --- |
| GLM 5.3 Flash | 435 ms, 472 ms | 2291 ms, 2483 ms |
| GPT-6 Luna | 406 ms, 503 ms | 2294 ms, 2680 ms |

The 6 min grant was not measured serially, because restore does not depend on how long the grant waited. The 6 min delay matters for cache, which the overlapped local approval run measures. Its timings are not comparable.

**Append.** From the serial host runs, controller time from a native transcript frame to its recorded reply:

- Computer: p50 6.0 to 6.6 ms, p95 23.9 ms, with 1 query at the median and at most 6.
- Serial approval: p50 6.1 to 6.5 ms, p95 12.9 to 13.8 ms, one query.

The runs before the reconnect pairing fix matched some frames of a resumed attempt to an earlier attempt's reply. Those samples read as negative, are left out, and are counted in `transcriptAppendsMispaired`.

**Success.** Every thread completed except one serial approval thread of GLM 5.3 Flash. In 9 of its 10 trials the run finished after the grant; in trial 7 the model asked for input again, with no error. In the overlapped approval run, GLM 5.3 Flash answered without calling the tool in 5 of 30 trials, so no approval was requested. No thread hit a provider error.

## Rollback compatibility

- **The guest and the controller ship together.** A guest bundle built before #306 still sends `systemPrompt`. The strict schema rejects that body as an unrecognized key, so the controller does not accept the frame. A controller from before #306 refuses the second transcript of an agent as `invalid`, so it cannot run a guest from #306 or later either. A worker template with a baked guest from before #306 must be rebuilt, or overridden with `--guest` in the live runner. Versioning the guest artifact is planned for P6.
- **The session log stays readable both ways.** `native` is an optional field on `tool.call`. A reader from before #306 ignores it. Calls logged before #306 carry no `native` mark, so `closeInterruptedNativeCalls` never touches them. Before #306, a native call and its result were logged together, so no call was left open.
- **Back-dated entries stay as they are.** Runs logged with the D9 back-dating keep their timestamps. Nothing migrates them.

## Limits

- A report the guest sends after the controller started stopping the attempt is refused. On a user cancel or a supersession, the attempt has already lost the run by then. On a controller shutdown or a loop-guard stop, a report in flight during the stop grace is lost. The call it would have answered stays open until a later attempt closes it as interrupted.
- The call a user cancel cut stays without a result in the cancelled run's log. No later attempt takes a cancelled run. A finished run reaches later history without its tool exchanges, so nothing replays the call.
- The frame schema is strict, so a guest bundle built before #306 is refused. See rollback compatibility.
- A cancel reaches a running attempt at its next lease heartbeat, up to 60 seconds later. Native work keeps running until then.
- Pause and resume of an E2B worker during an approval is not verified.

## Reproduce

Run the worker tests with a temporary `HOME` and at most two Vitest workers. Do not run the Electron E2E suite locally.

```sh
pnpm db:generate
pnpm check
pnpm lint
HOME="$(mktemp -d)" pnpm exec vitest run --maxWorkers=2 \
  packages/testkit/src/runtime-worker-native-transcript.test.ts \
  packages/testkit/src/runtime-worker-transcript.test.ts \
  packages/adapters/src/executor-history.test.ts \
  packages/adapters/src/runtime-worker/dialects/pi-ai-history.test.ts
```

To run the live lanes, build the bundle from the tested source and upload its guest into each owned worker. A template's baked guest from before #306 is refused.

```sh
pnpm test:worker-live:bundle
E2B_API_KEY=<key> E2B_DOMAIN=<domain> pnpm test:worker-live lanes \
  --harness pi-native \
  --guest packages/testkit/dist/worker-live/guest/agent-run-worker.mjs \
  --template <worker-template> --computer-template <computer-template> \
  --out <receipt-dir> --lanes native-kill-bash,native-cancel
```

For a self-hosted deployment, set `E2B_API_URL` and `E2B_SANDBOX_URL` instead of `E2B_DOMAIN`. On a host without a checkout, copy `packages/testkit/dist/worker-live` to `<scratch>` and run `node --expose-gc <scratch>/bin/worker-live.mjs lanes` with the same options and `--guest <scratch>/guest/agent-run-worker.mjs`. The runner refuses a deployment that already runs a sandbox, runs each lane in its own process, and sweeps the session's tagged sandboxes and named volumes after each lane.

S1 changed the transcript path that every native lane uses. To replay the earlier native lanes on the same source, add `g-timeout,native-helper-approval,native-catalog,native-compaction` to `--lanes`, as the P5 receipt did.
