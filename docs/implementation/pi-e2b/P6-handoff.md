# P6 validation handoff

**Status: validated on the self-hosted E2B host at the feature head.** All 21 live lanes pass on the
`rakazo-worker-pi-native` and `desktop` templates with the guest baked into the template. All four
journeys of [#200](https://github.com/RomainJeff/rakazo-bot/issues/200) ran against a real model.
Each of them did its work on E2B, and each stop ended the run. The feature is ready for the
maintainer's review. Nothing was deployed.

## What P6 delivered

- [#314](https://github.com/RomainJeff/rakazo-bot/pull/314). The `desktop` computer template builds
  from the canonical image on stock E2B. Chrome's profile stays on the machine's disk.
- [#318](https://github.com/RomainJeff/rakazo-bot/pull/318), on `main`. Daytona and Box are removed
  as computer providers.
- [#319](https://github.com/RomainJeff/rakazo-bot/pull/319). `SANDBOX_PROVIDER=e2b` runs bots in E2B
  workers, with no separate switch. New E2B team computers start on volumes.
- [#320](https://github.com/RomainJeff/rakazo-bot/pull/320). The legacy `pi` worker harness is
  removed, and `pi-native` is the only registered harness.
- [#321](https://github.com/RomainJeff/rakazo-bot/pull/321). The operator guide,
  [Self-host E2B workers](../../self-host-e2b-workers.md).
- [#322](https://github.com/RomainJeff/rakazo-bot/pull/322). The guest tool grant path is removed and
  the wire is at version 2.
- This slice:
  - The live bench and lane b time the native calls from the guest's transcript frames, not the
    removed grant frames.
  - Lane `g-timeout` checks upload deadlines only for an uploaded guest.
  - A new `worker-live accept` command runs the four journeys against a real model.
  - The operator guide is corrected.
  - It adds this handoff and the feature's CHANGELOG entry.

## References

| What | Value |
| --- | --- |
| Feature head validated | `3059f98db17dd682428c2d5ffc23e52d01817c1c` |
| Guest bundle SHA-256 | `b5ee633f555c84822ccab34f876aa6b6335c5c5eaf4442edeaee7abeae399785` |
| Worker template | `rakazo-worker-pi-native`, built at this slice from the head's guest, 1 vCPU and 1024 MB, built in 61 s |
| Computer template | `desktop`, built from #314. Not rebuilt: `infra/sandboxes/computer`, `skills/agent` and `skills/computer` are unchanged since #314. |
| SDK | pi-agent-core, pi-ai, pi-coding-agent and pi-telemetry 1.3.0, e2b 2.49.1 |
| Real model | OpenCode Go `glm-5.3-flash` through the user's model connection |

This slice changes only `packages/testkit` and docs, so the guest it bundles is the head's.

## Scenario and surface matrix

"Fixture" means the local model protocol emulator on real E2B VMs. "Real model" means GLM 5.3 Flash
on real E2B VMs.

| Scenario | Proof | Result |
| --- | --- | --- |
| Native file tools on both volumes, seen from a second VM and from the product computer (lanes a, b, b-product-computer) | Fixture | Pass |
| Separate PID and localhost between worker and computer (c) | Fixture | Pass |
| Controller tools, both model protocols, refusals (d, e-openai, e-anthropic, e-refusals) | Fixture | Pass |
| MCP-only run with no computer and no volume (f) | Fixture | Pass |
| Worker lost after provisioning, and killed at its E2B timeout (g, g-timeout) | Fixture | Pass, g-timeout on rerun |
| Home move to volumes, product recreate, move fence (h, h-product-recreate, home-move-fence) | Fixture | Pass |
| Skills on volumes (i, skills) | Fixture | Pass |
| Native approval, catalog, compaction, kill during bash, cancel (native-*) | Fixture | Pass |
| Code written and run in the worker, then run on the computer | Real model | Work done, see below |
| App served from the computer under its lease | Real model | Work done, see below |
| Browser on the computer, then a reply | Real model | Pass |
| MCP tool with no computer | Real model | Work done, see below |
| A stop during a tool, in each journey | Real model | Each run ended `cancelled` |

Surfaces: P6 adds no UI. The visible changes of the feature were captured in their own slices.
Shared skills on web at desktop width and 390x844 were captured in #261. The chat on an E2B computer
was captured at both widths in #299 (`evidence/P4/media`). The native iOS capture of the shared skill
viewer was not run in #261, nor here, because Maestro is not installed on the machine. The Electron
suite runs in CI.

## Lanes

[lanes.json](evidence/P6/lanes.json) holds one batch of 21 lanes without `--guest`, with
`--prepare-computer`.

- 20 lanes passed. `g-timeout` failed only its check that uploading a guest does not extend the VM's
  life. With the baked guest nothing is uploaded, so the list it checks was empty. Every product
  assertion of the lane held: E2B killed the VM, the attempt was released with its writer lease free,
  the bash was not rerun, and the run completed on a second attempt. The lane now checks upload
  deadlines only for an uploaded guest. It passed on rerun
  ([lanes-g-timeout-rerun.json](evidence/P6/lanes-g-timeout-rerun.json)).
- `b` and `b-product-computer` ran again with the final runner, which times visibility from the
  recorded native call ([lanes-b-rerun.json](evidence/P6/lanes-b-rerun.json)). Both passed. The
  computer saw the worker's writes within 28 to 63 ms of the call, including the tool's own run.
- Every lane ended with no sandbox and no volume of its own left.

## Real-model acceptance

[accept.json](evidence/P6/accept.json) records each journey in its own thread: a cold turn, a warm
turn with a variant of the task, then a turn stopped during its tool.

| Journey | What the bot did | Effect verified | Reply to the person |
| --- | --- | --- | --- |
| Code | Wrote `p6-fib.sh` with the native `write`, ran it with the native `bash`, ran the same file on the computer with `computer_exec`. Same for 12 numbers in the warm turn. | Yes, both turns | Cold: both outputs. Warm: none. |
| App | Started a Python server on port 8080 of the computer and checked it with curl. In the warm turn it changed the answer. | Yes: after each turn, the computer still answered `p6-app-ok`, then `p6-app-warm` | Cold: yes. Warm: none. |
| Browser | `browser_navigate` and `browser_snapshot` on example.com, then example.org | Yes | Both turns: "Example Domain" |
| MCP only | Called `publish_note` on the controller. The bot had no computer and no volume. | Yes, both notes | Cold: yes. Warm: none. |

Cost at catalog prices, all 12 turns: about $0.05. The most expensive turn was the warm app turn:
21 requests, 308k input tokens of which 229k were cached, $0.020.

**Turns that end silently.** GLM 5.3 Flash ended 3 of the 8 completed turns without `message_user`.
The person saw no reply, although the work was done. The two earlier runs had 4 and 3 such turns
out of 8 ([accept-second-run.json](evidence/P6/accept-second-run.json),
[accept-first-attempt.json](evidence/P6/accept-first-attempt.json)). The worker's prompt carries
the rule that a turn without `message_user` says nothing, checked with the fixture. This comes from
the model, not from the worker path, as far as one model shows. It is not compared with in-process
runs.

## Measurements

These are one cold and one warm sample per journey, from accept.json. Every run boots its own worker
VM, so "warm" means a running computer and an existing thread, not a running worker.

| Journey | Boot, cold / warm | First model event, cold / warm | Run, cold / warm | Stop after cancel | Worker VM memory used of 977 MiB | Computer memory used of 3931 MiB | Thread sweep |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Code | 2.38 / 2.49 s | 5.09 / 3.30 s | 15.9 / 11.9 s | 48.2 s | 175 to 176 MiB | 353 MiB | 39 ms |
| App | 2.50 / 2.14 s | 3.57 / 2.91 s | 36.0 / 51.6 s | 37.1 s | 174 to 176 MiB | 357 MiB | 31 ms |
| Browser | 2.61 / 2.44 s | 5.22 / 5.06 s | 16.3 / 13.7 s | 55.9 s | 174 to 176 MiB | 387 MiB | 25 ms |
| MCP only | 2.20 / 2.27 s | 5.06 / 3.06 s | 10.9 / 6.8 s | 54.4 s | 173 to 224 MiB | No computer | 11 ms |

- **Boot.** Boot runs from the provider's ensure to the guest's hello. The
  [bench](evidence/P6/bench.json) splits it into about 370 ms of E2B create and 1.9 to 2.2 s of
  guest start, which is the Node bundle's load
  ([#262](https://github.com/RomainJeff/rakazo-bot/issues/262)).
- **First model event.** This is from the run's start to the relay's first streamed event, so it
  includes the boot. The 1 to 2 s more in some cold turns also shows in the MCP journey, which has
  no computer. One sample cannot say where it comes from.
- **Stop.** Every stopped turn lasted 60.3 s from its start. The attempt sees a cancel at its first
  lease heartbeat, 60 s after it starts, so the time from the click to the stop depends only on how
  early in the attempt the person clicks.
- **CPU.** The worker's CPU busy share since boot was 0.08 to 0.30 of its one vCPU. The computer's
  was 0.04 to 0.11. Both were read inside each VM, because E2B's metrics API returns no samples on
  this deployment.
- **Cleanup.** The product's worker destroy call took 12 to 38 ms. Right after every run, no worker
  sandbox was left. The sweep after each thread killed the computer and destroyed the thread's
  volumes.
- **Census.** After all runs, the deployment listed no sandbox, running or paused, and no volume.

The bench, with the fixture model and two trials, measured the warm run of five native bash calls
at 1.18 to 1.43 s. The controller's cost per call was a median of 32 to 34 ms, and from a recorded
call to its result took a median of 22 to 23 ms. The bench reported no errors.

## Limits

- **Open egress.** Worker egress is not filtered. Code in the worker can send any file of the
  bot's and the space's volumes anywhere. The worker holds no model key or Rakazo secret.
- **Worker lifetime.** A worker lives at most one hour, the E2B sandbox timeout. A run that outlasts
  it continues in a new attempt.
- **Cancel delay.** A cancel reaches a running worker at the next lease heartbeat, up to 60 s later.
  The measured range was 37 to 56 s.
- **Pause during approval.** Pausing and resuming an E2B worker while a run waits for an approval is
  not verified.
- **Frame size.** The 8 MiB frame limit has not been tested against envd's stream.
- **Cold boot.** It takes about 2.2 to 2.6 s, nearly all guest start
  ([#262](https://github.com/RomainJeff/rakazo-bot/issues/262)).
- **OpenCode computer jobs.** They are out of scope.
- **Silent turns.** GLM 5.3 Flash sometimes ends a turn without `message_user`. See the acceptance
  section above.

## Deviations from #200

- **No rollback.** The maintainer decided against one. The move to volumes is one way, and runs on
  E2B have no switch back to in-process runs.
- **Reduced measurements.** By the maintainer's decision, this handoff has one cold and one warm
  sample per journey and one final census. It has no 30-trial before/after comparison and no ten
  cleanup cycles.
- **No pilot bot.** The workers are activated for every E2B deployment rather than for one internal
  pilot bot ([#319](https://github.com/RomainJeff/rakazo-bot/pull/319)).
- **`pi-runtime` stays.** `PiAgentRuntime` still runs every run without an E2B worker: on Docker, on
  `none` and on the trusted local computer
  ([#317](https://github.com/RomainJeff/rakazo-bot/issues/317)).

## Follow-ups

- [#317](https://github.com/RomainJeff/rakazo-bot/issues/317). Run pi-native in Docker workers and
  retire `PiAgentRuntime`.
- [#323](https://github.com/RomainJeff/rakazo-bot/issues/323). Make the worker's addendum and tool
  list per harness.
- [#262](https://github.com/RomainJeff/rakazo-bot/issues/262). Reduce the cold boot with a preloaded
  worker snapshot.
- Infra #4. Filter worker VM egress through an allowlist proxy.

## Operator procedure

Build `rakazo-worker-pi-native` and `desktop` from the commit you deploy, set `SANDBOX_PROVIDER=e2b`
with the E2B variables, then move each existing snapshot home once. The steps are in
[Self-host E2B workers](../../self-host-e2b-workers.md).

## Reproduce

[reproduce.txt](evidence/P6/reproduce.txt) gives every command, with placeholders for the host,
the scratch directory and the key file.
