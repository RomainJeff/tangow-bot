# How to add a harness

A harness is the agent loop that runs inside the guest VM. Pi is the only one today. This guide adds another one without changing the controller, the run channel or the session log. Read the [P2 handoff](P2-handoff.md) first. It defines the channel every harness speaks.

A harness is two things. The first is a guest adapter, which turns the harness's own loop into neutral frames. The second is a model dialect, which carries its model calls to the controller. Reuse the `pi-ai` dialect if the harness can call models through it. Add a dialect only when it cannot.

## Know what the controller already guarantees

The controller treats the guest as hostile, including the harness. Your adapter never authorizes anything. It asks, and the controller decides, as this table shows.

| Guarantee | Where it holds |
| --- | --- |
| The capability is checked before any database read. A capability of another attempt, an expired one, or a second connection while one is bound is refused. | `session.ts` `serve`, `capability.ts` |
| A tool runs only if the run exposes it, and only after its `tool` announcement with the same `callId`. Any other call ends the channel with `unknown_tool`. | `session.ts` `callTool` |
| A mutating guest tool starts only after the executor journaled the call and claimed its effect under the run's fence. A guest of an attempt that lost its run gets `revoked`, and the database refuses the claim. | `executor.ts` `claimEffectUnderFence` |
| A mutating guest tool's result counts only once the controller recorded it. A result that never arrives leaves the effect `executing`, and the next claim marks it `uncertain`. It is never run again. Read-only inspections execute again on retries. | `session.ts` `recordLocalResult`, `executor.ts` |
| An answered approval is settled before the next attempt starts. The controller runs the approved request once, under its effect's claim, or logs the refusal, as a call of the run under the effect's id. The attempt reads the outcome in its history and must not call the tool again. Only an approved tool the guest runs itself still resumes through the model's call. | `executor.ts`, before `runtime.run` |
| A `done` that arrives while a call is open is held until the call settles. | `session.ts` `finish` |
| Usage is measured on the model relay. The guest cannot report usage, provider, connection or owner: no frame carries them. | `session.ts` `relayModel` |
| Guest text, ask text, notices and tool output are redacted against the run's live secrets. Tool output is cut to `controllerResultBytes`. | `session.ts` `clean`, `cutText` |
| A frame that needs a capability the harness did not declare is refused with `undeclared`. | `FRAME_CAPABILITY` in `worker-protocol.ts` |
| Stop is confirmed within `stopConfirmMs`, or recorded as `unconfirmed`. No other guest of the run starts until the VM is confirmed gone. | `session.ts` `stop`, `launcher.ts` |

The guest receives no credential and no provider reference: no model key, endpoint, secret, connector route or volume id. It does know whose run it is. The run input in `worker.start` carries the bot and thread ids, and every frame carries the run, attempt and fence ids. The controller checks them; they grant nothing.

## Implement `GuestHarness`

Create `apps/agent-run-worker/src/harness/<name>.ts`. The interface is in `apps/agent-run-worker/src/harness.ts`:

```ts
interface GuestHarness {
    readonly declaration: HarnessDeclaration; // { name, capabilities }
    readonly nativeTools: readonly ConnectorTool[];
    executeNativeTool(name, args, callId, context): Promise<LocalToolOutput>;
    run(start: { worker: WorkerIdentity; run: GuestRunInput; cwd: string; skillsDir: string }, host: HarnessHost): Promise<DoneBody>;
}
```

`run` starts the attempt from `start.run`: prompt, instructions, history, images, tools with their placement, and the model description. It returns the final `done` body. The controller decides whether to accept it.

The host is the harness's only way out of the guest:

| `HarnessHost` member | Use it for |
| --- | --- |
| `signal` | Stop the loop. It aborts on `worker.cancel`, on `SIGTERM`, on a refusal, and when the controller is unreachable for good. |
| `emit(body)` | Text, progress, `tool` announcements and helper status. These are informative. The promise resolves once the window has room. |
| `decide(body, expected)` | Frames the controller decides: `ask`, `takeover`, `steering.claim`, the `subagent.*` frames. A refusal or an `error` reply throws. |
| `model(body, onPart, signal)` | One model call in the harness's dialect. Events arrive through `onPart` in order. Aborting `signal` sends `model.abort`, and the controller stops its upstream call. |
| `callTool(agent, name, args, callId)` | One tool call. Emit the `tool` announcement with the same `callId` first. A controller tool returns its output. A guest tool runs here after the grant, and its result is recorded before the promise resolves. |

Follow these rules:

- Announce each tool with `emit({ type: "tool", ... })` before `callTool`. The executor shows the announcement and waits for it before it journals the call.
- Never keep or ask for a key. Send every model call through `host.model`.
- Treat a throw from `decide`, `model` or `callTool` as the end of the attempt, unless the harness can report the failure to its model. A refusal has already ended the channel.
- Bring the harness's native file and shell tools. Declare their names, descriptions and JSON schemas in `nativeTools`, and implement `executeNativeTool` using the SDK's real factories with `context.cwd`. Keep SDK imports inside `harness/`. The generic guest calls this method only after the P2 grant and records its result before continuing. A successful native `read` of SKILL.md also reports skill usage. The adapter must use `captureToolOutput` for bounded text and volume spooling.
- Give the controller an SDK-free per-harness manifest and register it in `nativeToolsForHarness`. Pi generates `runtime-worker/pi-tools.json` from its tool factories. The bundle build checks it against the installed SDK. A second harness must also select its manifest in the runtime's `localTools` descriptor before the executor routes a run.
- Keep all Rakazo-specific tools on the controller, including computer, browser, memory, messages, MCP, integrations and routines. Do not remove them when adding native tools. Honor the selected list in `worker.start`; a missing tool must stay missing for both parent and helper. Removing a name does not remove what a remaining bash tool can do.
- Point the harness's skill loader only at `start.skillsDir`, the VM home's `~/.agents/skills/`. The generic runner has already converged managed, bot and shared sources in that precedence order and reported name collisions. Disable default skill paths and ambient AGENTS.md, settings, extensions and other context discovery. Pi uses an explicit `ResourceLoader` and `loadSkills({ skillPaths: [skillsDir], includeDefaults: false })`, then the SDK's skill catalog formatter. The controller supplies the rest of the context. Native read and bash tools consume the files. Pi runs inside the SDK's `AgentSession` with `SessionManager.inMemory` and that explicit `ResourceLoader`; the controller's history is replayed into the session manager before each prompt, and the session is disposed at run end. See [SDK adoption](P3-handoff.md#sdk-adoption) for what the session is allowed to do.

## Declare optional capabilities

A harness declares what it supports in `declaration.capabilities`. The core run (text, tools, ask, takeover, model calls, done) needs no declaration.

| Capability | Frames it allows | When the harness does not declare it |
| --- | --- | --- |
| `subagents` | `subagent`, `subagent.open`, `subagent.text`, `subagent.finish`, `subagent.abandon` | The controller does not offer `run_subagent`, and refuses those frames with `undeclared`. |
| `steering` | `steering.claim` | The attempt receives no steering. User messages sent during the run stay unclaimed, as with a runtime that never calls `claimSteering`. |
| `native-loop` | `transcript` | The harness runs no loop of its own, so every tool call goes through the controller and nothing needs ingesting. |

A `native-loop` harness reports its native session as it goes, in its model dialect, with `agent` naming a helper's session. Each `transcript` frame carries the messages that ended since the previous frame. Send it from a hook the loop awaits, at the end of every assistant message, every tool result and every compaction. An assistant message with a tool call is then in the controller's log before the tool runs. `runtime-worker/transcript.ts` ingests each agent's frames in order, against what the controller answered each `tool.call` of that agent. Each frame yields the steps it adds: text by turn, calls of the harness's own tools from its manifest in `nativeToolsForHarness`, their results, the names of the controller calls they make, and compaction summaries. The executor logs each own call as a `tool.call` when it appears and its result as a `tool.result` when it arrives, and each summary as a `harness.summary` that no history reads. Any other call, whatever its name, is never logged from the transcript: the controller's own answer is already in the log, and a result it never gave is only counted.

A frame is logged only while the attempt still owns its run. A call that has no result when its attempt ends stays open in the log: the VM died, the run was cancelled or a later attempt took the run. Before a later attempt of the same run reads its history, the executor closes each open call of a harness's own tool with an error result: its outcome is unknown and it was not replayed. Nothing runs it again.

Resume is not a capability. A controller restart ends the attempt, and the next attempt starts a new guest from the durable history in `worker.start`. A harness never resumes its own state across attempts. The same holds on E2B. A lost stdio stream ends the attempt, a sandbox that outlives its timeout is killed, and in both cases the next attempt boots a new VM from the history. Files the run wrote on its mounted volumes are still there. Output the guest spooled under `<private mount>/.rakazo/tool-output/` is too, but it is a convenience for the model, not part of the run's history.

## Use a model dialect

`ModelDialect` in `packages/adapter-kit/src/worker-protocol.ts` names the dialects. Only `pi-ai` exists. pi-ai's transcript goes out, and pi-ai's stream events come back. Its two halves live in `packages/adapters/src/runtime-worker/dialects/pi-ai.ts`: `piAiStreamFn` for the guest and `relayPiAiCall` for the controller.

To add a dialect:

1. Add the name to `ModelDialect`.
2. Make the `model.request` body a union on `dialect`, with a call schema for each dialect, and add the dialect's event schema to `ReplyPartSchema`. Today `model.request` accepts only `PiAiModelCallSchema`.
3. Write the controller relay as a `ModelRelay<Call, Event>` in `packages/adapters/src/runtime-worker/dialects/<name>.ts`, and register it in `RELAYS` in `session.ts`. The relay runs one call with the controller's model and key, sends each event, and returns the usage the provider reported.
4. Write the guest half next to it, and call it from the harness adapter.

The capability, the request count cap (`modelRequestsPerAttempt`), the frame cap (`modelRequestBytes`), `model.abort` and usage accounting stay in `session.ts`. They apply to every dialect without change.

## Add it to the worker template

1. Register the adapter in `HARNESSES` in `apps/agent-run-worker/src/harness/index.ts`, under the name it declares.
2. Select it with `RAKAZO_WORKER_HARNESS=<name>`. The default is `pi`. The guest entry point is `apps/agent-run-worker/src/main.ts`, and it also reads `RAKAZO_WORKER_CAPABILITY`, `RAKAZO_WORKER_ROOT` and `RAKAZO_WORKER_SPOOL_DIR`. It deletes the capability from its environment, so the commands a run starts do not inherit it.
3. Add the harness's SDK packages to both `noRestrictedImports` overrides in `biome.json`. The first override covers the generic guest code, which is everything under `apps/agent-run-worker/src/` except `harness/`. The second covers the controller's channel code, which is everything under `packages/adapters/src/runtime-worker/` except `dialects/`. `pnpm lint` then fails if an SDK import leaks outside `harness/` or `dialects/`.
4. Add the harness's layer to `HARNESS_LAYERS` in `apps/agent-run-worker/template/template.ts`, under the same name. The common base gives Node 24, bash, git, procps, CA certificates and `/workspace`. The layer adds only what the harness's own tools need outside the bundle. Pi's layer installs ripgrep and fd-find, because the native grep and find tools invoke them; Pi finds Debian's `fdfind` binary itself. The guest bundle, one ES module built by `pnpm --filter @rakazo/agent-run-worker bundle`, carries every registered harness and is copied last. E2B runs each build step as the sandbox user unless the step passes `{ user: "root" }`, and that user cannot write `/`, `/opt` or `/usr`. Pass it to any step that installs outside the user's home. The template needs no NFS client: E2B mounts the volumes itself.
5. Build the template with `pnpm --filter @rakazo/agent-run-worker template:build --harness <name>`. It bundles the guest, then builds `rakazo-worker-<name>` with `WORKER_PROFILE`, 1 vCPU and 1024 MiB. The E2B SDK reads `E2B_API_KEY`, and `E2B_API_URL` or `E2B_DOMAIN` for a self-hosted E2B, from the environment. Pass `--name` to choose another template name. The build uploads the template's files to a port a self-hosted deployment may expose on its own host only. In that case, run the build on that host.

The controller reaches the guest only through its stdio, which E2B relays through its command API. Each frame is one base64 line (`encodeFrameLine`, `readFrameLines` in `packages/adapters/src/runtime-worker/framing.ts`), because E2B hands command output through a text decoder that would corrupt raw bytes. P2's 4-byte length prefix is gone. A harness never writes to stdout. `main.ts` sends `console` to stderr, and a stray stdout line ends the attempt as an invalid frame.

Keep the generic files free of harness names. `guest.ts`, `outbox.ts`, `tool-output.ts` and `main.ts` must not change for a new harness, except for the entry in `HARNESSES`.

## Pass the conformance tests

Every harness must pass the same tests as Pi, offline:

- `packages/testkit/src/runtime-worker-guest.test.ts`, "run channel conformance of the Pi harness". It runs the harness against a real session inbox and the model emulator. It checks the order `tool`, `tool.call`, `tool.done`, `done`, and that a 5 MiB output stays bounded for the model and the wire and whole on the guest disk. Add a case that runs your harness from `HARNESSES`.
- `packages/testkit/src/runtime-worker.test.ts` and `runtime-worker-stop.test.ts`, the protocol lanes. They run the real executor through `LocalWorkerProvider`, which starts `HARNESSES.pi` in memory mode and `RAKAZO_WORKER_HARNESS=pi` in child mode. Make the harness name a `LocalWorkerProvider` option, then run the lanes with yours.
- `packages/testkit/src/runtime-worker-hostile.test.ts` tests the controller against a hand-written guest. It does not depend on the harness and needs no change.
- `pnpm bench:worker-channel` measures the control cost per tool and the stop delay. A harness should not move the control cost, because the controller does the same work for every harness.
- `pnpm test:worker-live` runs the P3 lanes against a real E2B deployment with the template you built. Lanes a, b, d and f exercise the harness: the file task against the in-process baseline, the local tools on the volumes, a disabled tool for the parent and a helper, and a large output. Lane i runs a bot without a computer through a worker with no mounts: an MCP tool served by the controller and `message_user` complete, so the harness must run with no native tools and no skills catalog. The `skills` lane checks all three skill sources, a script and a newly created skill on the next run. The [P3 handoff](P3-handoff.md) explains how to run them on a host with no checkout.

## Move a computer's files before its runs use workers

A worker uses its mounted private and shared volumes for persistent files, rather than the computer's AgentHomeStore snapshot. Native tools can also access the VM's temporary filesystem. A run that needs files stays in process until its computer's home moved onto volumes (`home_not_migrated`). The move is the same for every harness. `scripts/migrate-home-to-volumes.ts` plans, copies, verifies every file by hash and mode, then adopts. It reaches each volume through a sandbox of the worker template, so the template must have Node, as the base gives. The [P3 handoff](P3-handoff.md) gives the procedure, the retention and the rollback.

Run `pnpm lint` to prove the import rule holds.
