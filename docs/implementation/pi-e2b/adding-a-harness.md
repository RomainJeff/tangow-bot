# How to add a harness

A harness is the agent loop that runs inside the guest VM. `pi-native` is the only one today. This guide adds another one, such as Codex, next to it. The controller, the run channel and the session log do not change. Read the [P2 handoff](P2-handoff.md) first: it defines the channel every harness speaks.

A harness runs its own loop, prompt and tools in the VM. Rakazo gives it three things:

- A model relay. The harness holds no key. Every model call goes to the controller in a model dialect, and the controller runs it with the run's own model and key.
- Rakazo's tools. Computer, browser, memory, messages, connectors and the rest run at the controller. The harness reaches them as `tool.call` frames, usually through the Rakazo MCP server.
- A transcript. The harness reports each message of its native session as it ends. The controller turns those messages into canonical history.

The harness's own tools (files, shell, search) run in the VM. The controller never runs them for the harness, and never authorizes them one by one: the VM and its mounts are the boundary.

## Know what the controller already guarantees

The controller treats the guest as hostile, including the harness. Your adapter never authorizes anything. It asks, and the controller decides.

| Guarantee | Where it holds |
| --- | --- |
| The hello is checked before anything else: the capability, the attempt it names, and the harness name and capabilities the controller launched. A capability of another attempt, an expired one, another harness or a second bound connection is refused. | `session.ts` `serve`, `capability.ts` |
| Every message carries `WORKER_PROTOCOL_VERSION`. A peer of another version is refused with `version`. Frames are strict: an unknown frame or field is refused with `invalid`. | `worker-protocol.ts`, `framing.ts` |
| A controller tool runs only if the run exposes it, and only after its `tool` announcement with the same `callId`. A call of the harness's own tools, or of any tool the run does not expose, ends the channel with `unknown_tool`. | `session.ts` `callTool`, `open` |
| A controller tool runs under the executor's journal and effect claims, with the run's approvals. | `executor.ts` |
| A `done` that arrives while a controller call is open is held until the call settles. A `native-loop` harness must report its root transcript before `done` is accepted. | `session.ts` `finish` |
| Usage is measured on the model relay. No frame carries usage, provider, connection or owner. Requests and tokens are capped per attempt. | `session.ts` `relayModel`, `limits.ts` |
| Guest text, questions, notices, tool output and transcripts are redacted against the run's live secrets, and cut to `controllerResultBytes`. | `session.ts` `clean`, `transcript.ts` |
| A frame that needs a capability the harness did not declare is refused with `undeclared`. | `FRAME_CAPABILITY` in `worker-protocol.ts` |
| Once a pause latched, calls are answered without running and the attempt only concludes. | `session.ts` `pause` |
| Stop is confirmed within `stopConfirmMs`, or recorded as `unconfirmed`. No other guest of the run starts until the VM is confirmed gone. | `session.ts` `stop`, `launcher.ts` |

The guest receives no credential and no provider reference: no model key, endpoint, secret, connector route or volume id. It does know whose run it is: `worker.start` carries the bot and thread ids, and every frame carries the run, attempt and fence. The controller checks them; they grant nothing.

## Implement `GuestHarness`

Create `apps/agent-run-worker/src/harness/<name>.ts`. The interface is in `apps/agent-run-worker/src/harness.ts`:

```ts
interface GuestHarness {
  readonly declaration: HarnessDeclaration; // { name, capabilities }
  run(
    start: { worker; run: GuestRunInput; cwd; skillsDir; outputRoot?; agent? },
    host: HarnessHost,
  ): Promise<DoneBody>;
}
```

`run` starts one session from `start.run`: prompt, Rakazo's instructions, canonical history, images, the offered tools and the model description. `start.agent` names a helper session; it is absent for the root. `run` returns the final `done` body, and the controller decides whether to accept it.

The host is the harness's only way out of the guest:

| `HarnessHost` member | Use it for |
| --- | --- |
| `signal` | Stop the loop. It aborts on `worker.cancel`, on `SIGTERM`, on a refusal, and when the controller is unreachable for good. |
| `emit(body)` | Text, progress and `tool` announcements. These are informative. The promise resolves once the window has room. |
| `decide(body, expected)` | Frames the controller decides: `transcript`, `steering.claim`, `subagent.text`, `skills.used`, `ask`, `takeover`. A refusal or an `error` reply throws. |
| `model(body, onPart, signal)` | One model call in the harness's dialect. Events arrive through `onPart` in order. Aborting `signal` sends `model.abort`, and the controller stops its upstream call. |
| `callTool(agent, name, args, callId)` | One controller tool. Emit its `tool` announcement first. It resolves with the controller's output. |

Follow these rules:

- Never keep or ask for a key. Send every model call through `host.model`, in your dialect.
- Run your own file and shell tools in the VM, under `start.cwd`. Keep bash output whole on the mount: `durableBashTool` keeps it under `start.outputRoot` with `captureToolOutput`, and shows the model a bounded head and tail.
- Offer Rakazo's tools to your model from `start.run.tools`. A tool with `where: "controller"` is Rakazo's; serve it with `rakazoMcpServer` in `apps/agent-run-worker/src/rakazo-mcp.ts`, which announces each call and runs it through `host.callTool`. A tool with `where: "guest"` is one of yours the run allows; enable only those. A missing tool must stay missing for the root and for helpers.
- Report every message of your session through `decide({ type: "transcript", ... }, "recorded")` from a hook your loop awaits, before the loop acts on it. See [Report a transcript](#report-a-transcript).
- Treat a throw from `decide`, `model` or `callTool` as the end of the attempt, unless your loop can report the failure to its model. A refusal has already ended the channel.
- Point your skill loader only at `start.skillsDir`, the VM home's `~/.agents/skills/`. The generic runner has already converged the managed, bot and shared sources and reported name collisions. Report a successful read of a `SKILL.md` with `skills.used`; `skillReadName` names it. Disable every other discovery: default skill paths, ambient settings, extensions, and the volume's own project config. Pi native uses `DefaultResourceLoader` with `noSkills: true` and `additionalSkillPaths: [skillsDir]`, and never trusts the volume's `.pi/`.
- Keep your SDK imports inside `harness/`. The generic files (`guest.ts`, `outbox.ts`, `tool-output.ts`, `rakazo-mcp.ts`, `main.ts`) do not change for a new harness.

## Declare capabilities

A harness declares what it supports in `declaration.capabilities`, and registers the same declaration for the controller in `workerHarness` (`packages/adapter-kit/src/worker-harnesses.ts`). The controller refuses a hello that differs from the harness it launched.

| Capability | What it allows | Without it |
| --- | --- | --- |
| `native-loop` | `transcript` frames. The harness runs its own loop and tools. | The controller expects no transcript. Every registered harness declares it. |
| `steering` | `steering.claim`, to take the user's new messages at a turn boundary. | User messages sent during the attempt stay for the next run. |
| `subagents` | `run_subagent`. On that call the controller opens the helper's log and answers with a `subagent.start` part; the guest runs that helper as a session of its own, named `agent`, through the same `run`. | The controller does not offer `run_subagent`. |

## Report a transcript

A `transcript` frame carries the messages that ended since the previous frame, in the harness's dialect, with `agent` naming a helper's session. Send one at the end of every assistant message, every tool result and every compaction. An assistant message with a tool call is then in the controller's log before the tool runs.

`runtime-worker/transcript.ts` ingests each agent's frames in order, with the dialect's ingest. It keeps text by turn, calls of the harness's own tools and their results, the names of the controller calls the harness made, and compaction summaries. A call is the harness's own only if its name is in the harness's manifest (`nativeToolsForHarness`). Any other call is never logged from the transcript: the controller's own answer is already in the log. A result the controller never gave is only counted. A report needs the model requests and calls behind it, or it is refused with `budget`.

A frame is logged only while the attempt owns its run. A call that has no result when its attempt ends stays open in the log. Before the next attempt reads its history, the executor closes each open call of a harness's own tool with an error result: its outcome is unknown, and nothing runs it again.

Resume is not a capability. A lost channel, a controller restart or a killed VM ends the attempt, and the next attempt starts a new guest from the durable history in `worker.start`. Files on the mounted volumes are still there.

## Use a model dialect

`ModelDialect` in `packages/adapter-kit/src/worker-protocol.ts` names the dialects. Only `pi-ai` exists: pi-ai's transcript goes out, and pi-ai's stream events come back. Its halves live in `packages/adapters/src/runtime-worker/dialects/`: `piAiProviderStream` for the guest, `relayPiAiCall` for the controller, and `ingestPiAi` for transcripts. Reuse `pi-ai` if your harness can speak it. Add a dialect only when it cannot:

1. Add the name to `ModelDialect`.
2. Make the `model.request` body a union on `dialect`, with a call schema for each, and add the dialect's event schema to `ReplyPartSchema`. Today both accept only pi-ai's shapes.
3. Write the controller relay as a `ModelRelay<Call, Event>` in `dialects/<name>.ts` and register it in `RELAYS` in `session.ts`. It runs one call with the controller's model and key, sends each event, applies the model's image budget, and returns the usage the provider reported.
4. Write the transcript ingest and register it in `INGEST` in `transcript.ts`.
5. Write the guest half next to them, and call it from your adapter.

The request and token caps, `model.abort`, the frame caps and usage accounting stay in `session.ts` and apply to every dialect.

## Give the controller your tool manifest

The controller loads no harness SDK. Generate an SDK-free manifest of your own tools (name, description, JSON schema, read-only) and register it in `nativeToolsForHarness` in `runtime-worker/guest-input.ts`. Pi generates `runtime-worker/pi-tools.json` from its tool factories with the worker's `tools:manifest` script, and the bundle build fails when it is stale. The manifest decides which offered tools are marked `where: "guest"`, which calls the transcript ingest treats as yours, and which names the controller refuses to run for you.

## Add it to the worker template

1. Register the adapter in `HARNESSES` in `apps/agent-run-worker/src/harness/index.ts`, under the name it declares.
2. The guest reads `RAKAZO_WORKER_HARNESS` (default `pi-native`), `RAKAZO_WORKER_CAPABILITY`, `RAKAZO_WORKER_HOME` and `RAKAZO_WORKER_ROOT`. It deletes the capability from its environment. The controller's E2B provider sets the harness from its `harness` option.
3. Add your SDK packages to both `noRestrictedImports` overrides in `biome.json`. `pnpm lint` then fails if an SDK import leaks outside `harness/` or `dialects/`.
4. Add your layer to `HARNESS_LAYERS` in `apps/agent-run-worker/template/template.ts`. The base gives Node 24, bash, git, procps, CA certificates and `/workspace`; a layer adds only what your tools need outside the bundle. Pi's installs ripgrep and fd-find. Pass `{ user: "root" }` to a step that installs outside the user's home.
5. Build it with `pnpm --filter @rakazo/agent-run-worker template:build --harness <name>`. It bundles the guest and builds `rakazo-worker-<name>`.

The controller reaches the guest only through its stdio, one base64 line per frame. A harness never writes to stdout: `main.ts` sends `console` to stderr, and a stray stdout line ends the attempt as an invalid frame.

## Pass the conformance tests

Every harness passes the same offline tests as Pi native:

- `packages/testkit/src/runtime-worker-guest.test.ts`, "run channel conformance of the pi-native harness". It runs the harness against a real session inbox and the model emulator, and checks the frame order, that each own call is reported before it runs, and the skills catalog. Add a case for yours from `HARNESSES`.
- `runtime-worker-native.test.ts`, `runtime-worker-native-transcript.test.ts` and `runtime-worker-relay.test.ts`. They run the real executor through `LocalWorkerProvider` and check the canonical history the transcript produces, helpers, steering, compaction, bounded output and the relay's image budget. Pass yours as the fixture's `harness` option.
- `runtime-worker.test.ts` and `runtime-worker-stop.test.ts`, the protocol lanes, with the same option.
- `runtime-worker-hostile.test.ts` and `runtime-worker-handshake.test.ts` test the controller against a hand-written guest. They do not depend on the harness.
- `pnpm test:worker-live` runs the live lanes against a real E2B deployment with the template you built. The [P3 handoff](P3-handoff.md) explains how.

## What is Pi-specific today

A second harness supplies these. Everything else is shared.

| Piece | Pi native's | Where |
| --- | --- | --- |
| Guest adapter | `piNativeHarness`, with `durableBashTool` and the Pi MCP transport | `apps/agent-run-worker/src/harness/` |
| Model dialect, both halves | `pi-ai`: `piAiProviderStream`, `relayPiAiCall` | `runtime-worker/dialects/pi-ai.ts` |
| Transcript ingest for the dialect | `ingestPiAi`, and `projectPiAi` for the history the guest replays | `runtime-worker/dialects/pi-ai-history.ts` |
| Image budget for the dialect | `prunePiAiImages` | `runtime-worker/dialects/pi-ai-images.ts` |
| Tool manifest | `pi-tools.json`, registered in `nativeToolsForHarness` with Pi's `tool_search` | `runtime-worker/guest-input.ts` |
| Declaration | `PI_NATIVE_HARNESS` in `workerHarness` | `packages/adapter-kit/src/worker-harnesses.ts` |
| Template layer | ripgrep and fd-find | `apps/agent-run-worker/template/template.ts` |
| Prompt addendum | `buildHarnessAddendum` | `packages/adapters/src/executor.ts` |

Two places still assume Pi outside these. Fix them when the second harness lands:

- The addendum is chosen for every worker run, not per harness. It tells the model to call Rakazo tools as `mcp__rakazo__<name>`, to use `tool_search`, and to use native `read`, `write`, `edit` and `bash`. Those are Pi's names.
- The worker runtime declares Pi's manifest as its `localTools` (`runtime-worker/runtime.ts`), whichever harness the provider launches. The executor offers those names to the run.
