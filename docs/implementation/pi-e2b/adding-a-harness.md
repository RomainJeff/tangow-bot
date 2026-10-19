# How to add a harness

A harness is the agent loop that runs inside the guest VM. Pi is the only one today. This guide adds another one without changing the controller, the run channel or the session log. Read the [P2 handoff](P2-handoff.md) first: it defines the channel every harness speaks.

A harness is two things. The first is a guest adapter, which turns the harness's own loop into neutral frames. The second is a model dialect, which carries its model calls to the controller. Reuse the `pi-ai` dialect if the harness can call models through it. Add a dialect only when it cannot.

## Know what the controller already guarantees

The controller treats the guest as hostile, including the harness. Your adapter never authorizes anything. It asks, and the controller decides:

| Guarantee | Where it holds |
| --- | --- |
| The capability is checked before any database read. A capability of another attempt, an expired one, or a second connection while one is bound is refused. | `session.ts` `serve`, `capability.ts` |
| A tool runs only if the run exposes it, and only after its `tool` announcement with the same `callId`. Any other call ends the channel with `unknown_tool`. | `session.ts` `callTool` |
| A guest tool starts only after the executor journaled the call and claimed its effect under the run's fence. A guest of an attempt that lost its run gets `revoked`, and the database refuses the claim. | `executor.ts` `claimEffectUnderFence` |
| A guest tool's result counts only once the controller recorded it. A result that never arrives leaves the effect `executing`, and the next claim marks it `uncertain`. It is never run again. | `session.ts` `recordLocalResult`, `executor.ts` |
| A `done` that arrives while a call is open is held until the call settles. | `session.ts` `finish` |
| Usage is measured on the model relay. The guest cannot report usage, provider, connection or owner: no frame carries them. | `session.ts` `relayModel` |
| Guest text, ask text, notices and tool output are redacted against the run's live secrets. Tool output is cut to `controllerResultBytes`. | `session.ts` `clean`, `cutText` |
| A frame that needs a capability the harness did not declare is refused with `undeclared`. | `FRAME_CAPABILITY` in `worker-protocol.ts` |
| Stop is confirmed within `stopConfirmMs`, or recorded as `unconfirmed`. No other guest of the run starts until the VM is confirmed gone. | `session.ts` `stop`, `launcher.ts` |

The guest never receives a model key, an endpoint, a secret, a connector route, a volume id or an owner id. `worker.start` carries the run input as data only.

## Implement `GuestHarness`

Create `apps/agent-run-worker/src/harness/<name>.ts`. The interface is in `apps/agent-run-worker/src/harness.ts`:

```ts
interface GuestHarness {
	readonly declaration: HarnessDeclaration; // { name, capabilities }
	run(start: { worker: WorkerIdentity; run: GuestRunInput }, host: HarnessHost): Promise<DoneBody>;
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
- Do not define guest tools in the harness. The controller places them: `GUEST_TOOLS` in `packages/adapters/src/runtime-worker/guest-input.ts`, and the guest runs them from `LOCAL_TOOLS` in `apps/agent-run-worker/src/local-tools.ts`. Every harness shares them.

## Declare optional capabilities

A harness declares what it supports in `declaration.capabilities`. The core run (text, tools, ask, takeover, model calls, done) needs no declaration.

| Capability | Frames it allows | When the harness does not declare it |
| --- | --- | --- |
| `subagents` | `subagent`, `subagent.open`, `subagent.text`, `subagent.finish`, `subagent.abandon` | The controller does not offer `run_subagent`, and refuses those frames with `undeclared`. |
| `steering` | `steering.claim` | The attempt receives no steering. User messages sent during the run stay unclaimed, as with a runtime that never calls `claimSteering`. |

Resume is not a capability. A controller restart ends the attempt, and the next attempt starts a new guest from the durable history in `worker.start`. A harness never resumes its own state across attempts.

## Use a model dialect

`ModelDialect` in `packages/adapter-kit/src/worker-protocol.ts` names the dialects. Only `pi-ai` exists: pi-ai's transcript goes out, and pi-ai's stream events come back. Its two halves live in `packages/adapters/src/runtime-worker/dialects/pi-ai.ts`: `piAiStreamFn` for the guest and `relayPiAiCall` for the controller.

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

Keep the generic files free of harness names. `guest.ts`, `outbox.ts`, `local-tools.ts` and `main.ts` must not change for a new harness, except for the entry in `HARNESSES`.

## Pass the conformance tests

Every harness must pass the same tests as Pi, offline:

- `packages/testkit/src/runtime-worker-guest.test.ts`, "run channel conformance of the Pi harness". It runs the harness against a real session inbox and the model emulator. It checks the order `tool`, `tool.call`, `tool.done`, `done`, and that a 5 MiB output stays bounded for the model and the wire and whole on the guest disk. Add a case that runs your harness from `HARNESSES`.
- `packages/testkit/src/runtime-worker.test.ts` and `runtime-worker-stop.test.ts`, the protocol lanes. They run the real executor through `LocalWorkerProvider`, which starts `HARNESSES.pi` in memory mode and `RAKAZO_WORKER_HARNESS=pi` in child mode. Make the harness name a `LocalWorkerProvider` option, then run the lanes with yours.
- `packages/testkit/src/runtime-worker-hostile.test.ts` tests the controller against a hand-written guest. It does not depend on the harness and needs no change.
- `pnpm bench:worker-channel` measures the control cost per tool and the stop delay. A harness should not move the control cost, because the controller does the same work for every harness.

Run `pnpm lint` to prove the import rule holds.
