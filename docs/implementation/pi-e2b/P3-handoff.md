# P3 native Pi in the worker and file migration handoff

The live receipts describe commit `b5c0a4609b926d12d6c7d6a28d7a801fcc0875f8`, before S7. The historical harness reported fourteen passing lanes, but lane i checked refusal and left the computerless run running. S7 ([#254](https://github.com/RomainJeff/rakazo-bot/pull/254), merged at `7bbff551c`) changed the runtime, native tools and template after that live run. S6 changes routing, migration fencing and timing again. Neither revision has live E2B evidence. Rebuild the template and rerun the lanes before accepting the current runtime. The historical figures below remain evidence of their tested commit only.

## Integrated references

- Feature base: `feature/pi-e2b-workers` at `710705aee`. It contains P0, P1, P2, the multi-writer shared volume ([#224](https://github.com/RomainJeff/rakazo-bot/pull/224)) and the P3 slices: guest file tools ([#228](https://github.com/RomainJeff/rakazo-bot/pull/228)), the E2B provider, codec, bundle and template ([#229](https://github.com/RomainJeff/rakazo-bot/pull/229)), the home move ([#241](https://github.com/RomainJeff/rakazo-bot/pull/241)) and the composition ([#243](https://github.com/RomainJeff/rakazo-bot/pull/243)).
- This slice: branch `claude/pi-e2b-p3-live`, merged with the feature base after #243. The tested commits are in the [verification receipt](evidence/P3/verification.json).
- Predecessor handoffs: [P0](P0-handoff.md), [P1](P1-handoff.md), [P2](P2-handoff.md). Infrastructure: I1, delivered in the infrastructure repository's pull request #2 (merge `177c1ff`), with its receipts at `9c1b44e` (functional) and `a38c067` (isolation). Its main branch was at `e17503b` during the runs.
- SDKs: pi-agent-core, pi-ai, pi-telemetry and pi-coding-agent 1.3.0, unchanged. The E2B SDK is `e2b@2.49.1` in the application. The E2B platform build is the one the I1 handoff records. This slice did not read it again.
- Templates: the worker template `p3live-worker-pi`, built from `apps/agent-run-worker/template` at the tested commit, and I1's `i1-computer` for the computer VMs. Both stay on the host.

## What P3 adds, by layer

| Layer | Slice | Files | Content |
| --- | --- | --- | --- |
| Guest tools | #228, replaced by S7 | `apps/agent-run-worker/src/harness/pi-tools.ts`, `tool-output.ts`, `runtime-worker/pi-tools.json` | Pi coding-agent 1.3.0 supplies native `read`, `write`, `edit`, `bash`, `grep`, `find` and `ls`. P2 still grants and records each local effect. The in-process tools keep their existing contracts. |
| Provider | #229, #243, S5 | `packages/adapters/src/e2b-worker.ts` | `E2BWorkerProvider` implements `WorkerProvider` and `GuestConnector`. One `secure` sandbox per attempt, tagged `{ rakazo: "worker", attemptId }`, volumes mounted by name, created and deleted by name. The sandbox timeout is the worker TTL, `WORKER_TTL_SECONDS`, one hour. Where a deployment allows less (`maxTimeoutMs`), the provider caps it and logs a warning. |
| Codec | #229 | `packages/adapters/src/runtime-worker/framing.ts` | `encodeFrameLine` and `readFrameLines`: one base64 line per frame on stdio, replacing P2's 4-byte length prefix. E2B delivers command output through a text decoder, and base64 survives it. |
| Template | #229, S5 | `apps/agent-run-worker/template/template.ts`, `build.ts`, `scripts/bundle.ts` | Node 24 base with bash, git, procps and CA certificates, and the guest bundle at `/opt/rakazo/agent-run-worker.mjs`. The Pi layer installs ripgrep and fd-find, with an fd symlink for Debian. Root steps run as root, and `/workspace` belongs to the sandbox user. `WORKER_PROFILE` is 1 vCPU and 1024 MiB. |
| Home move | #241, S5 | `packages/adapters/src/home-volume-migration.ts`, `e2b-volume-files.ts`, `scripts/migrate-home-to-volumes.ts` | `moveHomeToVolumes`: plan, copy, verify by hash and mode, adopt. `E2BVolumeFiles` reaches each volume through a sandbox that mounts it. It stages each file 0600 beside its target and renames it over the target, and it replaces a sandbox only once the control plane no longer lists it. |
| Lifecycle | #241, #243 | `packages/adapters/src/worker-lifecycle.ts`, `packages/db/src/volumes.ts` | `ensureVolume` with an `ensureUntil` deadline, `provisionAttachedBotVolume`, `inspectHomeMove`, `adoptVolumeHome`, owner deletion with volume tombstones, and `sweepVolumes`. |
| Composition | #243 | `packages/adapters/src/worker-composition.ts`, `executor.ts`, `e2b-sandbox.ts`, `runtime-worker/session.ts`, `apps/api/src/app.ts`, `apps/worker/src/index.ts` | `composeWorkers` in both roots. The executor routes a run by `deriveRunNeeds` and owns the setup retry budget. The reconciler releases lost workers and sweeps deleted volumes. The E2B computer mounts the volumes and links its workspace to their root. The relay masks the transcript and runs every call with the controller's model, key and session. |
| Live lanes | S5 | `packages/testkit/src/worker-live/`, `cli/worker-live.ts`, `cli/bundle-worker-live.ts` | `pnpm test:worker-live` and `pnpm test:worker-live:bundle`. |

## Architecture

```mermaid
flowchart LR
  subgraph controller["Rakazo controller"]
    executor["Executor<br/>fenced claims · routing · setup budget"]
    runtime["Worker runtime<br/>session · relay · stop journal"]
    lifecycle["Worker lifecycle<br/>plan · start · release · reconcile · sweep"]
    db[("PostgreSQL")]
    model["Model provider<br/>key held here"]
  end
  e2bapi["E2B API<br/>sandboxes · volumes"]
  subgraph worker["Worker VM, one per attempt"]
    guest["runGuest · Pi harness<br/>file tools · bash"]
  end
  subgraph computer["Computer VM"]
    apps["apps · browser · services<br/>/home/user/rakazo-home → /workspace"]
  end
  volumes[("Bot private volume<br/>space shared volume")]
  executor --> runtime
  runtime --> lifecycle
  lifecycle --> db
  executor --> db
  lifecycle -- "create · kill · ensureVolume · deleteVolume" --> e2bapi
  runtime -- "base64 frame lines over command stdio" --> guest
  runtime -- "relay, masked" --> model
  guest -- "/workspace/bots/&lt;botId&gt; · /workspace/shared" --> volumes
  apps -- "same paths" --> volumes
```

The worker and the computer are separate VMs with separate kernels. They share files only through the volumes, which E2B serves over NFS from the orchestrator, at the same paths in both VMs. The controller, the session log, the database and every key stay outside both VMs.

## Run a worker

1. Build the worker template under the name the deployment will use: `pnpm --filter @rakazo/agent-run-worker template:build --name rakazo-worker-pi`. The build uploads the template's files to a port that a self-hosted deployment may expose on its own host only. In that case, build on that host.
2. Set `WORKER_PROVIDER=e2b` with E2B's standard environment: `E2B_API_KEY`, and `E2B_API_URL` with `E2B_SANDBOX_URL`, or `E2B_DOMAIN`. Set `WORKER_TEMPLATE` only for another template name. Both the API and the job worker read them.
3. Move each computer's home onto volumes, as in [Home move, retention and rollback](#home-move-retention-and-rollback). A bot whose home is still a snapshot keeps running in process.

To check a deployment, run the lanes: `pnpm test:worker-live lanes --template <worker template> --computer-template <computer template> --out <dir>`, with `--lanes a,b` to pick lanes, and the bench: `pnpm test:worker-live bench --template <worker template> --computer-template <computer template> --out <dir> --trials 30`.

For a host with no checkout, `pnpm test:worker-live:bundle` writes `packages/testkit/dist/worker-live/`: the lanes as one ES module for Node 22, PGlite's assets, the migrations, the guest bundle, the hand-written guest of lane e-refusals, and the two modules the E2B SDK imports to upload template files. Copy that directory, then run `node live/bin/worker-live.mjs template --guest live/guest/agent-run-worker.mjs --name <template>` and the commands above with `node --expose-gc live/bin/worker-live.mjs` in place of `pnpm test:worker-live`. The exact sequence is in [reproduce.txt](evidence/P3/reproduce.txt).

The guest starts as `node /opt/rakazo/agent-run-worker.mjs`. `RAKAZO_WORKER_CAPABILITY` is on the command only, and the guest deletes it from its environment. `RAKAZO_WORKER_HARNESS` and `RAKAZO_WORKER_SPOOL_DIR` are on the sandbox. The spool directory is `<private mount>/.rakazo/tool-output` when the run mounts the private volume, and the guest's temporary directory otherwise.

## Tool selection and helpers

The executor routes each run by its tools. `deriveRunNeeds` mounts the private volume when the run has a file tool or the computer's `shell`, and the space's shared volume only for a team computer's bot. A worker run hides `shell`: the guest's `bash` replaces it. A bot without a computer is offered no computer or file tools. MCP, integration and `message_user` calls can complete in process or in a worker with no mounts. An attached file that needs a computer fails through the fenced finalizer with a clear error. Lane i now requires completion with no computer, volumes or mounts; its revised live run is pending.

The controller puts every tool of the run in `worker.start` with its place. The Pi adapter installs the SDK's native `read`, `write`, `edit`, `bash`, `grep`, `find` and `ls` at the mounted working directory. The controller uses the SDK-free `runtime-worker/pi-tools.json` manifest, generated by `pnpm --filter @rakazo/agent-run-worker tools:manifest`; the bundle build rejects a stale manifest. Worker runs remove `list_files`, `read_file`, `write_file`, `edit_file` and `shell`. The in-process path keeps them.

Rakazo-specific tools, including computer and browser operations, memory, `message_user`, MCP, integrations and routines, stay on the controller. Native calls still announce `tool`, request `tool.call`, wait for `tool.grant`, send `tool.done`, and wait for `tool.recorded`. Fenced effect claims for mutating tools, journal entries and controller-side redaction still apply. Both the parent and helpers inherit the run's tools. Native read-only flags come from the controller manifest, so inspections execute again on retries and do not require webhook side-effect approval.

Read and edit reject files larger than 250 KiB before loading them; use bash for bounded processing of larger files. Native reads keep a whole-line head and continue at the first unseen line within the 12000-character model budget. Truncated bash output keeps the exit or timeout status beside its truncation marker.

Native contracts differ from the old tools. `write` replaces existing files. `edit` takes an `edits` array with `oldText` and `newText`. Paths are ordinary VM paths: relative paths start in the bot's private mount, and shared files are at `/workspace/shared`. There is no custom workspace path resolver or volume-only write guard.

There is no product setting to disable individual native tools. Helpers inherit the run's native tools and controller tools minus `message_user` and `DELEGATION_TOOL_NAMES`. Lane d exercises the product's model capability filter: `computer_act` is absent for a model without vision, for both the parent and helper. A guest requesting an unexposed tool is refused with `unknown_tool` (lane e-refusals).

## S7 decision and session context

The maintainer decision replaces P3's original tool choice:

> "In the worker VM, generic file and shell tools must be the harness's NATIVE tools."

For Pi these are the seven coding-agent tools above. Rakazo stops maintaining their worker implementations. Everything Rakazo-specific remains a controller tool, and the in-process path stays unchanged.

Today the adapter uses pi-coding-agent's native tool factories and `PiAgentRuntime` (pi-agent-core), relayed through P2 pi-ai. `PiAgentRuntime` owns the transcript, context pruning, loop, approvals, helpers, steering and recaps. The relay receives its converted messages directly. No coding-agent session or resource loader is used.

Adopting pi-coding-agent's `AgentSession` with an in-memory session and an explicit `ResourceLoader` that loads skills from volume paths is deferred to the planned skills slice. The issue's "session mémoire et resource loader explicite" requirement is not met by this slice. Model keys and provider connections remain on the controller.

S7 updates live lanes a, b and f without running E2B. Lane a compares final file content against the in-process baseline; native names, overwrite behavior and result formats may differ. The historical receipts below do not validate S7. Rebuild the worker bundle and template before rerunning these lanes.

## Model relay and capabilities

The guest never holds a model key, an endpoint or a connection. Every model call is a `model.request` frame in the `pi-ai` dialect. The controller masks the run's live secrets in the transcript's text, leaves image data as it is, and runs the call with its own model, key and session id.

- **OpenAI protocol (lane e-openai).** The fixture key was in no guest environment and no guest process's `/proc/<pid>/environ`, while three relayed calls reached the emulator, which checks the controller's bearer key on each call.
- **Anthropic protocol (lane e-anthropic).** A catalog Anthropic model billed with a plain API key, its Messages API emulated on loopback, with a thinking block and a tool call. Three calls relayed with the controller's `x-api-key`, and no guest process held it. Offline, the same run counts the provider's cache reads into the run's input tokens.
- **Refusals (lane e-refusals).** A hand-written guest in the worker VM asked for a model call naming its own model, endpoint and key. The controller ended the run as `The worker broke the run protocol: invalid`, and the upstream got no call. In a second run it called a tool the run does not expose: the controller answered `refused`, ended the run as `unknown_tool`, and released the worker.

The relay reached only the repository's emulator. No real provider was called, and no real key was in the guest.

## Cleanup states

A worker is destroyed only when E2B confirms it, and a writer lease frees only in the transaction that records that. Lane g drove each fault below on real sandboxes, and each run completed.

| What fails | Attempt after the fault | Lease and sandbox | Run | How it ends |
| --- | --- | --- | --- | --- |
| The VM dies right after `ensure` | `released`, ref recorded | Freed, none left | Requeued, then completed on a new VM | Setup fails, release finds the VM gone, and the run is requeued under its setup budget. |
| `ensure` fails after E2B created the VM | `releasing`, no ref | Lease held, VM alive | Requeued, then completed on a new VM | Release cannot tell an in-flight create from none, so it waits for the ensure deadline, 15 minutes. Until then the retry is a busy wait. Reconcile then destroys the VM by its attempt tag and frees the lease. The lane moved the deadline into the past instead of waiting. |
| `prepare` fails after the ref was recorded | `released`, ref recorded | Freed, none left | Requeued, then completed on a new VM | `start` releases its own worker at once, and the run is requeued under its setup budget. |
| The controller dies after `start` | `ready`, ref recorded, recorded before reconcile | Lease held, VM alive | Lease lapses | Reconcile releases it once the run's lease expires: VM destroyed, lease freed. |
| A worker outlives the sandbox timeout | `released` | Freed, none left | Requeued, then completed on a new VM | E2B killed the VM, the stream broke and release found it gone. The next attempt asked for the same `bash` call and got `its outcome is unknown`: the effect became `uncertain` and never ran again. Lane g-timeout gave the sandbox a 20 s timeout, and E2B killed it about 23 s after the run started. |

**Setup budget.** An error from volume creation, `ensure` or `prepare` requeues the run, and the executor counts it against a budget of three setup failures per run, kept in the attempt rows so it survives queue replacement and controller restarts. The third failure fails the run with `Run setup failed after 3 attempts: <reason>`.

- A controller crash before setup completes counts, so three crashes stop the run on its next delivery, before another provider call.
- A busy wait counts nothing: computer or volume contention, or an earlier worker of the run still releasing before its ensure deadline.
- An intentional requeue after a late takeover release counts nothing either.
- Past its deadline, a writer that cannot be released charges the run waiting on it. That covers an earlier worker of the same run, and another run's writer that is releasing, lost its fence or has an expired run lease. A provider that refuses both creation and destruction therefore cannot keep a run queued forever.

P2's stop contract is unchanged: `worker.cancel`, a grace of `cancelGraceMs`, then release, recorded `unconfirmed` when E2B does not confirm within `stopConfirmMs`.

## Home move, retention and rollback

Move one computer's home at a time, with the source computer stopped. A team move also requires no live worker in its space; a dedicated move permits unrelated running computers and workers. S6 reserves the space's existing computers with a durable `home-move:` maintenance marker before planning or copying files. Worker planning and start refuse it as busy, as do computer boots. A computer on volumes added during the copy checks the same space lock when claiming boot or replacement. Busy run retries consume no setup budget and leave no attempt row when no worker was started. Completion, refusal and exceptions release the reservation in `finally`.

The marker identifies the move owner and has a one-minute expiry, renewed every ten seconds throughout planning and copying. Reconciliation automatically releases expired reservations, including when no worker provider is configured. The script can also release an expired reservation with `--computer <id> --clear-stale-move`, without E2B credentials; it reports when nothing matched. An expired owner cannot renew or adopt. Rerun the move with a fresh manifest path to resume after recovery.

1. Run `pnpm exec tsx scripts/migrate-home-to-volumes.ts --computer <id> --dry-run --template <worker template>`. The dry run creates nothing and prints the plan with any refusal.
2. Run it again with `--manifest <path>` instead of `--dry-run`. The path must not exist. It creates and provisions the volumes, writes only planned files, reads every file back and compares its sha256 and mode with the plan, then adopts. It writes the manifest once it creates anything.
3. Keep the manifest. It lists each file's home path, volume, volume path, size, sha256 and mode.
4. Start the computer again. The product's E2B computer mounts the volumes, links `/home/user/rakazo-home` to their root, and records `home: "volumes"` and a digest of its mounts in its metadata. A machine with another set of mounts is archived and replaced. Nothing imports the snapshot over the volumes or exports them back.

Lane h-product-recreate moved a team home with a snapshot, booted the product computer, changed a moved file from it, then recreated the computer with `recover`. The new machine mounted the volumes and still held the changed file, so no snapshot restore wrote over the volumes, and the home revision did not change.

The command reaches each volume through a sandbox of the worker template with only that volume mounted, and destroys those sandboxes when it ends. Each file is created 0600 by the guest user, filled, given its mode, then renamed over its target. Lane h checked live that an upload into a file created 0600 keeps that mode and inode. A sandbox that fails a call with `SandboxNotFoundError`, the SDK's "killed or reached its end of life" error or envd's 502 is replaced only once the control plane no longer lists it, because the SDK raises all three for a live sandbox behind a failing proxy too. Otherwise the call fails and the sandbox stays. Lane h killed its three volume-file sandboxes and the next read went through a new one. The command reads `DATABASE_URL`, `DATA_DIR`, and E2B's standard environment.

Lane h moved a synthetic team home of two bots, with files in mode 0755, 0644, 0640 and 0600. The dry run created no volume. The move adopted, and all six files matched the manifest by hash and mode on the volumes. Two computer VMs created one after the other on the same volumes saw the same hashes, and kept a file written between them. A second move answered `already_on_volumes`. A second team computer of the same space was refused with `volume_not_empty`, because the shared volume already held the first home's files.

**Retention.** The AgentHomeStore snapshot stays as the pre-move original, and nothing writes to it after adoption. Deleting a bot deletes its volume, and deleting a space deletes its shared volume. The deletion records each volume, and `sweepVolumes` deletes it at E2B after its ensure deadline, then repeats the delete for one hour before it clears the record. Guest tool output stays on the private volume under `.rakazo/tool-output/`, up to `localOutputSpoolBytes` (16 MiB) per command. The guest keeps the newest `localOutputSpoolFiles` (16) files and removes the oldest, except those of commands still running.

**Rollback.** Follow #241's procedure. Stop the computer, copy back any file written on the volumes since adoption, then set `computers."homeStorage"` back to `snapshot`. Files written on the volumes after adoption and not copied back are lost. The volumes stay, and a later move onto them is refused with `volume_not_empty` until they are emptied.

### Answers to #241's open questions

- **Volume path format.** E2B addresses a volume by its name. The lifecycle names it `rakazo-<volume row id>`, and the provider records that name as the volume's provider ref. A sandbox mounts the whole volume at its P1 path, `/workspace/bots/<botId>` or `/workspace/shared`.
- **Overwrite.** A second write of a path replaces its content and leaves the mode the last write set. The move never writes a path it did not plan, so it rewrites only its own interrupted copies.
- **A fresh volume is empty.** A new volume lists no entry, and the move found nothing foreign on the volumes it created.
- **Guest uid.** E2B's sandbox user is uid and gid 1001 in this template, not 1000. The Node image already has a `node` user at 1000. The moved files belong to 1001. Lane h tested one case of ownership: on the shared volume, that user read and appended to a file root had made 0600. Treat isolation as holding between volumes and VMs, not between users of one VM.

## What #243 asked the live slice to prove

| Point | Result |
| --- | --- |
| A worker and a computer mount the same volumes and see each other's writes, both ways | Proven with the product computer, lane b-product-computer. The computer saw the guest's private write 55 ms and its shared write 29 ms after the controller granted the tool that wrote it, matched by its request's seq, and the guest read both files the computer wrote. |
| The workspace link works on a fresh sandbox | Proven. `/home/user/rakazo-home` links to `/workspace`, and the lane wrote and polled through it. |
| `getInfo().metadata` carries the home marker and the mounts digest; a matching machine is reused | Proven. The metadata has `home: "volumes"` and a digest, and the second run reused the first run's machine. A machine with another set of volumes was not tried live. |
| `Volume.list` and `Volume.destroy` delete a volume by name | Not run through `deleteVolume` or `sweepVolumes`. Each lane's sweep listed and destroyed its volumes by name with the same two calls. |
| Accepted volume creates finish within one hour after the ensure deadline | Not measured. A client cannot observe the server's bound. |
| The relay keeps streaming, tool calls, thinking, usage and cache accounting | Proven against the emulator on both protocols, not against a real provider. |
| The guest user can write the mounted volumes; sandbox and command environments merge | Proven by lanes b and f: the guest wrote both volumes as uid 1001, read its capability from the command and its spool directory from the sandbox. |
| A cold boot fits `helloDeadlineMs` and `capabilityTtlMs` | Proven: 2.1 s at p95 with two mounts, against 30 s and 10 minutes. Control cost on PostgreSQL was not measured. |
| The reconciler releases a lost worker, and the sandbox is gone at E2B | Proven for a controller lost after start, through `lifecycle.reconcile` (lane g). The `unconfirmed` stop path was not driven live. |

## Live receipts

Receipts are in `evidence/P3/`: [verification.json](evidence/P3/verification.json), [lanes.json](evidence/P3/lanes.json), [bench.json](evidence/P3/bench.json), [template.json](evidence/P3/template.json), [reproduce.txt](evidence/P3/reproduce.txt) and the [lane capture](evidence/P3/media/lanes-cli.png). Every lane ran in its own process on the shared E2B host, one at a time, after a check that no sandbox ran on the deployment and that the host had at least 1,536 MiB available. Every lane ended with no sandbox and no volume of its session left.

| Lane | Issue item | Result | Observed |
| --- | --- | --- | --- |
| a | File task identical to the baseline | Pass | `notes.md` read from the volume after the VM was destroyed is `alpha\ngamma\n`, as in process. The model saw the same seven results, and the log holds the same results. |
| b | Local tools and two-way visibility | Pass | The guest read both files a computer-template VM wrote, wrote and edited its own, and grep found both. The VM's poller saw the private write 50 ms and the shared write 46 ms after the controller granted the tool that wrote it. |
| b-product-computer | Visibility with the product's E2B computer | Pass | See [What #243 asked the live slice to prove](#what-243-asked-the-live-slice-to-prove). |
| c | Distinct PID namespace and localhost | Pass | Each listener answered on 127.0.0.1 in its own VM and was refused from the other. Neither VM listed the other's process. The kernels' boot ids differ. |
| d | Disabled tool for parent and helper | Pass | See [Tool selection and helpers](#tool-selection-and-helpers). |
| e-openai | OpenAI-protocol relay | Pass | See [Model relay and capabilities](#model-relay-and-capabilities). |
| e-anthropic | Anthropic-protocol relay | Pass | See [Model relay and capabilities](#model-relay-and-capabilities). |
| e-refusals | Refused connection, model or endpoint | Pass | See [Model relay and capabilities](#model-relay-and-capabilities). |
| f | Large output kept after destruction | Pass | `seq 1 900000` printed 6,188,895 bytes. The model saw 9,918 characters and the log 4,839 bytes. The whole output was read back from the private volume with no sandbox alive, byte for byte. |
| g | Fault after provisioning | Pass | See [Cleanup states](#cleanup-states). |
| g-timeout | VM killed at its sandbox timeout | Pass | See [Cleanup states](#cleanup-states). |
| h | Move with hashes and computer recreation | Pass | See [Home move, retention and rollback](#home-move-retention-and-rollback). |
| h-product-recreate | Recreating the product's computer after a move | Pass | See [Home move, retention and rollback](#home-move-retention-and-rollback). |
| i | Run with no files and no computer | Historical acceptance gap; revised lane pending | The old lane passed its refusal predicate while leaving the run running. S6 now requires completed `message_user`, no computer or volumes, and an empty worker mount list. |

The two product-computer lanes skip the computer's desktop preparation. This host has no desktop template, and preparing one installs the desktop packages, which the lanes do not use.

## Performance

These are historical S5 results, before S7 and S6. Direct proxy overhead and PostgreSQL RSS acceptance remain pending.

Lane j ran 30 trials of three arms, rotating which arm went first: P2's local runner in memory on the same host, an E2B worker of a dedicated computer's bot, which mounts its private volume, and an E2B worker of a team computer's bot, which also mounts the shared volume. Each run makes five `bash` calls, a `message_user` and the recap, through the real executor on PGlite. There were no errors in the 90 runs. All numbers are absolute. The figures below are p50 and p95. The full distributions are in [bench.json](evidence/P3/bench.json).

| Measure | Local runner | E2B, private volume | E2B, two volumes | Budget |
| --- | --- | --- | --- | --- |
| Cold boot, create to hello | | 1.75 s, 2.04 s | 1.86 s, 2.23 s | Under 30 s |
| Sandbox create | | 343 ms, 362 ms | 354 ms, 384 ms | |
| Guest boot, command start to hello | | 1.39 s, 1.72 s | 1.50 s, 1.86 s | |
| Warm run, hello to accepted end | 472 ms, 495 ms | 953 ms, 1.18 s | 1.02 s, 1.25 s | |
| Control per guest tool | 34 ms, 42 ms | 43 ms, 57 ms | 43 ms, 60 ms | |
| Relay at the controller, request to end | 13 ms, 19 ms | 10 ms, 30 ms | 11 ms, 31 ms | |
| Relay before the upstream received the call | 6 ms, 9 ms | 4 ms, 13 ms | 5 ms, 16 ms | |
| Grant to result, one round trip and `echo` | 20 ms, 21 ms | 24 ms, 43 ms | 25 ms, 48 ms | |

**Cold boot passes its budget by a factor of 13 at p95.** The guest boot bounds it. In a fresh VM, `node -e 0` took 0.70 s and loading the 7.6 MB guest bundle 0.88 s, against 0.03 s and 0.54 s once the page cache was warm. That profile is one VM of five runs per command. Mounting volumes adds about 270 ms to the create: an earlier run of this bench measured 79 ms with no mount, which matches I1's 65 ms against 350 ms.

The historical relay estimate does not establish the 200 ms p95 budget. It added two separate distributions and did not time individual guest calls. S6 records the guest-local elapsed time from sending each model request frame to receiving its first model event. The bench subtracts the matching emulator's own time to first byte, then reports p50, p95 and max of those differences per arm as `proxyOverheadDirectMs`. Missing guest timings fail the bench rather than falling back to an estimate. `perf.proxy_overhead_direct` in the verification receipt is an explicit pending placeholder with no invented values.

**The transcript mask was most of the relay, and this slice cut it.** #243 masks the run's secrets in every relayed transcript. Before this slice's fix, the same bench measured the relay at 56 ms at p50 and 87 ms at p95 with the private volume, 50 ms of it before the emulator received the call. A timing probe in the relay, run on the host and not committed, put 28 to 36 ms of each call in the mask for transcripts of 30 to 34 KB with three secrets. The mask tried to parse every string and every key as JSON, and each failed parse threw. It now parses only text whose first character past whitespace opens an object, an array or a string, the only texts that can parse to one, and it prepares the secrets' escaped forms once per walk. Masking is unchanged. The relay is now 10 ms at p50 and 30 ms at p95, back to its 9 ms and 29 ms before #243, and the local runner's warm run went back from 801 ms to 472 ms.

**Control per tool is PGlite on this host, not the network.** The control window is controller-side only, from `tool.call` read to `tool.grant` sent plus `tool.done` read to `tool.recorded` sent. Database calls take 97 to 99 percent of it, 17 queries at p50, as in P2. A `SELECT 1` round trip to PGlite takes 0.46 ms on this host against 0.11 ms on the machine of P2's numbers, four times slower, so P2's 6.0 ms becomes the local runner's 34 ms here. E2B adds 9 ms at p50 to the same window. This slice infers that the extra time is the frames' arrival through E2B's command stream interleaving with the window's queries, and did not trace it.

**Control cost on PostgreSQL was not measured.** The controller has to run on the E2B host, whose API listens there only. PostgreSQL there needs Docker under sudo, which the rules for the shared host exclude. P2's estimate still stands, about 17 network round trips per tool on PostgreSQL.

**The controller grew 53 MiB of RSS over 90 runs, and the growth traces to its test database.** RSS went from 1,153 to 1,206 MiB with a garbage collection before each sample, and the JS heap from 156 to 203 MiB. A heap snapshot comparison in an earlier investigation run found the growth in arrays of PostgreSQL wire messages held by the in-process PGlite instances, about the number of protocol messages those runs exchanged. This points to the test database, but does not prove the PostgreSQL RSS result. S6 adds `--database postgresql`, using `DATABASE_URL` and at least ten rotating trials, with a disposable migrated database per arm. `perf.rss_postgres` is pending with no measured values. Over the last ten runs, RSS grew 3.4 MiB and the heap 4.3 MiB. Each lane runs in its own process for the same reason, since one process grew about 200 MiB per lane.

The host had 8 vCPUs with a one-minute load average of 1.0 to 2.5 during the bench, from the host's other services. The arms rotated, so each saw the same load.

## Limits

- Native tools are not confined to the mounted volumes. The former file-tool "writes refused off the volumes" guard is removed, consistent with bash's existing ability to write elsewhere. Only volume writes outlive the VM.
- Every native text result is bounded to 12,000 characters and 2,000 lines for P2. Longer results are spooled under the configured output directory, at most 16 MiB per file and 16 retained files. Bash capture counts all raw bytes and preserves the output up to that cap on the private volume, including after VM destruction. Pi's internal temporary bash copy is separately capped and removed on successful tool completion. Other tools may apply the SDK's own pagination or truncation before the P2 bound; their spool contains the SDK result, not necessarily the entire source file.
- Native `read` forwards an image when its complete result fits the 64 KiB controller result budget. Larger image results are serialized and spooled as bounded text. Automatic SDK image resizing is disabled to keep the standalone bundle independent of native image libraries.
- SDK bash temporary output created on abort or timeout may remain until VM destruction. It is not the durable spool.
- The revised live native-tool lanes remain pending. No E2B VM was created for S7.


### Attention

- **Worker VMs have no egress firewall.** `E2BWorkerProvider` asks for no network restriction, and the guest network is open. Guest code, including a Pi that `bash` modified, can send any file of its mounts anywhere. No key is in the guest, but the bot's and the space's files are.
- The guest is hostile, including its Pi. Worker frames are not a tamper-proof audit of what the guest did on its mounts. On the shared volume, the sandbox user read and appended to a root-owned 0600 file, so do not count on uids inside one VM to protect files.

### Lifetimes and retries

- A worker lives one hour, `WORKER_TTL_SECONDS`, the limit of E2B's base plan and of a self-hosted deployment left at its default. Nothing extends it yet, so a run that outlives it loses its VM and resumes on a new attempt. A deployment that allows less sets `maxTimeoutMs`, and each capped create logs a warning.
- A create whose answer was lost keeps its writer lease and its VM until the ensure deadline, 15 minutes, then reconcile destroys it. Until then, the run's retries are busy waits.
- A provider error that never clears, a bad key for instance, ends the run only through the setup budget, after three failures.
- A guest call whose result was lost stays `executing` when the next attempt never asks for it again, even after the run completes. It becomes `uncertain` only when a later attempt claims the same call.
- The computerless-running defect observed by historical lane i is fixed offline in S6. Its revised live completion lane remains pending.

### Volume deletion

- A deleted volume waits for its ensure deadline, up to 15 minutes, before its first delete, even when provisioning returned. Its record then stays for one hour after the latest deadline, and every eligible sweep deletes the name again. That assumes every create E2B accepted finishes within that hour. A create that finishes later, after the last successful sweep, leaks a volume. The lanes did not measure that bound.
- A recorded volume whose delete keeps failing stays at the head of the sweep's batch of 10, oldest first. Ten such records stall the sweep until the provider recovers, and each failure is logged. Ten records still in their grace hour delay later records the same way.

### Transport and redaction

- A broken stream during a kill in progress is logged as a lost connection.
- When another actor destroys a sandbox, the controller's `exited` for that guest stays pending. The stop is still bounded and recorded `unconfirmed`.
- An 8 MiB controller frame becomes a base64 line of about 11 MiB on stdin. No test checked it against envd's request size limit.
- A lost stdio stream ends the attempt. There is no reconnect over E2B.
- A secret that straddles a page boundary of a guest file read is not redacted in that page's result. The guest pages the file, and the controller masks each page's result on its own.

### Home move

- S6 reserves only the source computer for a dedicated move and fences only its bots' workers and private volumes. Sibling screens, stops, execution leases, worker starts and computer boots remain available. A team move reserves every existing computer and fences worker starts and volume-home boots across the space because it copies the shared volume. Historical worker-count comparisons remain a secondary adoption check.
- Reservation expiry and renewal use the database clock. The copy checks a local monotonic deadline before every write and adoption, five seconds before the one-minute TTL, measured from the last successful renewal's request start. A renewal taking more than five seconds cancels the copy, including through its abort signal.
- Do not deploy during a running home move. The expiry migration gives existing markers one minute, but a pre-fix move script does not renew or check ownership before adoption. Finish or stop that script before deploying.
- If the manifest write fails in the move's `finally`, its error replaces the move's report.
- A move resumes between files only. A staged `.rakazo-<uuid>` file is removed when its write fails or is cancelled, and by the retry when its sandbox died. A move process that dies mid-write still leaves one beside its target, and the next move refuses it as foreign. Remove it by hand.
- A volume-file sandbox that `close` never reached dies at its one-hour timeout. Creating one gives up after two minutes.
- A shared file overwritten before adoption is not recovered. Adoption is refused in that case.

### Measurement

- The guest bundle loads in about 1.5 s on a cold VM. Warming the page cache in the template snapshot or a Node compile cache could cut it. Neither was tried.
- The lanes run the controller on PGlite. Control cost on PostgreSQL across the E2B network is not measured.
- The live bundle replaces two modules the lanes never call with stubs: Koffi, a native module the home store loads only on macOS and Windows, and jsdom, which reads its stylesheet from beside its own sources.
- The web E2E selector result is in the verification receipt. There is no user interface change, so the only capture is the lane capture.

## Entry conditions for successors

- **P4** exposes the remote tools: `computer_*`, `browser_*` and `computer.exec` stay controller tools, and every ordinary file or shell action stays local in the worker. It decides how computer tools return images, because a controller tool's output reaches the guest as JSON, and where a team computer keeps its browser profiles, which a replacement archives but does not restore.
- **P5** rebuilds a session from the durable history in `worker.start` and never from the worker's disk. The spool under `.rakazo/tool-output/` is a convenience, not the truth of a run. It reads `effectPhase` and never reruns an `uncertain` effect, and it starts no writer before `stopState` says `destroyed`. It uses the same template and launch path, and adds nothing to the guest for resume.
- **P6** starts from the measured profiles: worker 1 vCPU and 1024 MiB, computer 2 vCPU and 4096 MiB, cold boot p95 2.1 s with two mounts. It measures control cost on PostgreSQL, decides how to keep a run alive past the sandbox timeout, decides on a worker egress policy, and repeats the lanes under concurrent runs on one host.

## S6 offline acceptance follow-up

S6 tests the real executor, local Pi guest, emulator and database offline. It covers computerless MCP/integration calls, missing-computer finalization, busy retries without budget charge, a launch attempted during a copy, automatic expiry recovery, live-copy renewal, honest operator recovery output, and guest-local model timing. PostgreSQL integration additionally races worker start against move reservation and exercises the disposable PostgreSQL bench fixture. Exact verification outcomes and the main web E2E comparison are in `s6_verification` in the [verification receipt](evidence/P3/verification.json).

No live E2B, real provider, Electron E2E or native mobile capture ran for S6. No frontend code changed. The revised live lanes, including screenshots, direct proxy budget and PostgreSQL RSS are pending. The changelog entry remains with the final feature slice under the feature-branch convention.

## Rollback

S6 adds the nullable `computers.homeMoveExpiresAt` column. Leave that additive column in place on rollback. Do not deploy or roll back during a running home move. To roll back the runtime, revert its commits. The worker TTL then returns to four hours, and the template fix, the timeout cap and the volume-files rewrite return to the code from #229 and #241, which cannot build its template, create a worker or reach a volume on the self-hosted deployment. Unset `WORKER_PROVIDER` first so that no run uses a worker, then drain running workers: each ends within its TTL. The worker template `p3live-worker-pi` stays on the host until someone deletes it with `DELETE /templates/<templateId>` on the local API.
