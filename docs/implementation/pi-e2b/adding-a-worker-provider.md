# How to add a worker provider

This guide adds a provider that runs one worker per run attempt and mounts bot and space volumes. The worked example is Docker. Two providers exist: E2B in `packages/adapters/src/e2b-worker.ts`, and Docker in `packages/adapters/src/docker-worker.ts`, which drives containers through the sandbox supervisor ([#317](https://github.com/RomainJeff/rakazo-bot/issues/317)). Both computer kinds keep their homes on volumes. Read the [P1 handoff](P1-handoff.md) for the contract history.

A provider is an adapter that implements `WorkerProvider` and `GuestConnector`, a guest image, a computer that mounts the same volumes, and a way to move existing homes onto them. Nothing else in the controller changes. Harness concerns, such as native tools, transcripts and the guest's model relay, belong to [how to add a harness](adding-a-harness.md).

## Know what the controller already guarantees

The controller decides ownership, fences and leases before it calls the provider. Your adapter never checks that a volume belongs to the bot, and it never chooses a path. It receives a `WorkerSpec` from `packages/adapter-kit/src/worker-provider.ts` that is already authorized:

```ts
interface WorkerSpec {
	attemptId: string;
	runId: string;
	botId: string;
	mounts: Array<{ volumeRef: string; path: string; access: VolumeAccess }>;
	ttlSeconds: number;
	ensureDeadline: Date;
}
```

`volumeRef` is the volume name passed to `ensureVolume`, which must return that same name. `path` is `/workspace/bots/<botId>` or `/workspace/shared`. Mount each volume at exactly that path.

A run that uses files mounts its bot's private volume and its space's shared volume, both `rw`. The private volume takes a single-writer lease: `volumes.writerAttemptId` holds the attempt, and a second attempt of the bot waits until the first worker is confirmed destroyed. The lease never frees on a clock. The shared volume takes no lease, so two bots of one space write it at once. A volume records the `describe().id` of the provider that created it, and the controller refuses to mount it through another provider.

## Implement `WorkerProvider`

Create the adapter in `packages/adapters/src/`, next to `e2b-worker.ts`. Keep every vendor call in this file and in its composition root, as `AGENTS.md` requires.

Each method has a rule that the controller depends on for safety:

| Method | Rule | Docker example |
| --- | --- | --- |
| `describe()` | Report `readOnlyMounts` truthfully. If the provider cannot enforce a read-only mount, report `false`, and the controller refuses `ro` grants. E2B reports `false`. | Bind mounts and named volumes accept `:ro`, so report `true`. |
| `ensure(spec)` | Create one worker tagged with `spec.attemptId` and return its reference. The controller calls it once per attempt. Never create the worker after `spec.ensureDeadline`, the instant the controller stops waiting for it. | Create a container with the label `rakazo.attempt=<attemptId>`, mount each volume at its `path`, and stop it after `ttlSeconds`. Cancel creation when the deadline passes. Return the container id. |
| `prepare(ref, spec)` | Finish fallible setup after the reference is recorded. It must be idempotent. E2B does nothing here: the guest's hello is its readiness check. | Start the container and wait until the mounts are visible. |
| `destroy({ attemptId, providerRef })` | Remove every worker tagged with `attemptId`, with or without a reference. Return `absent` when none is left. Never treat "not found" as an error. | Remove every container with the label `rakazo.attempt=<attemptId>`, forced. Leave the volumes in place. |
| `ensureVolume({ name, ensureDeadline })` | Create the named volume, or return it. Always return `name` as its reference. Stop submitting creates before `ensureDeadline`. Server processing must finish within the one-hour deletion grace period after it, including when the controller dies or loses the response. | Create the volume `name` if it is missing, and return `name`. Bound the request by the deadline. |
| `deleteVolume({ providerRef })` | Delete the named volume, even if `ensureVolume` never returned. One already gone is not an error. | Remove the volume `providerRef` if it exists. |

Volumes outlive every run. Before calling `ensureVolume`, the controller commits an `ensureUntil` deadline under the volume row lock. The name is always `rakazo-<volumeId>`, so a reference can be recovered without a provider response. Deleting a bot or a space deletes its volume rows and records every volume in `volume_deletions` in the same transaction, including rows with no recorded reference.

The lifecycle's `sweepVolumes` waits until that deadline before deleting the named volume. It retains the record for one hour after the latest deadline and repeats the idempotent delete on every eligible sweep. The grace period assumes every create the provider accepted finishes within one hour after its ensure deadline. A create that finishes later can leak a volume. Prove this bound for a new provider, or increase the shared grace period before enabling it. The sweep never lists the provider's volumes, so other deployments' volumes stay untouched.

Respect the TTL at the provider. If the controller never confirms destruction, the TTL is the last bound on a worker that still holds a volume. `WORKER_TTL_SECONDS` in `packages/core/src/worker-plan.ts` is one hour, the most E2B allows by default. A provider whose deployment allows less caps the worker's lifetime at that limit and logs a warning, as `E2BWorkerProvider` does with `maxTimeoutMs`.

## Connect to the guest

`GuestConnector` in `packages/adapters/src/runtime-worker/launcher.ts` has one method. `connect({ attemptId, providerRef }, capability)` starts the guest in the worker and returns its frame channels, the harness the controller expects, and an `exited` promise. Settle `exited` only once the guest process is seen gone, never on the guest's word.

E2B runs `node /opt/rakazo/agent-run-worker.mjs` through its command API, passes the capability in `RAKAZO_WORKER_CAPABILITY`, and carries newline-framed frames over the command's stdin and stdout. That stdio is the only route between the controller and the guest. A Docker provider can do the same with `docker exec` and an attached stdin. `LocalWorkerProvider` in `packages/testkit/src/local-worker-provider.ts` runs the guest as a local process the same way.

The guest is the bundle of `apps/agent-run-worker`. Each provider ships it in its own image:

- E2B builds the template `rakazo-worker-pi-native` with `pnpm --filter @rakazo/agent-run-worker template:build`. `apps/agent-run-worker/template/template.ts` lays out Node 24, `bash`, `/workspace`, the managed skills read-only at `/managed-skills`, and the bundle.
- A Docker provider builds an image with the same layout from the same `bundleGuest()` output in `apps/agent-run-worker/scripts/bundle.ts`.

Every frame carries the protocol version from `packages/adapter-kit/src/worker-protocol.ts`. The controller refuses a guest whose version or harness declaration differs from its own, so an image built from another commit can fail its hello. Build the image from the same commit as the controller.

## Enable the computer kind

Two places decide which computer kinds keep their home on volumes. Change both in the same pull request.

1. Add a migration that extends `computers_home_storage_check`, which allows `volumes` on `e2b` and `docker` computers. Drop and recreate the constraint as `NOT VALID`, then validate it in a second migration, as `20261026000000_docker_home_volumes` and `20261026000001_validate_docker_home_volumes` do:

	```sql
	ALTER TABLE "computers" DROP CONSTRAINT "computers_home_storage_check";
	ALTER TABLE "computers" ADD CONSTRAINT "computers_home_storage_check" CHECK (
	    "homeStorage" = 'snapshot' OR ("homeStorage" = 'volumes' AND "kind" IN ('e2b', 'docker'))
	) NOT VALID;
	```

2. In `createBot` in `packages/db/src/repos.ts`, a new team computer starts on volumes when its kind is `e2b` or `docker`. Extend that condition to the new kind. A dedicated computer created later takes its team computer's `homeStorage`.

The lifecycle no longer checks the kind before it adopts a home: the constraint is the only guard, and the `fake` computer of the tests stays on snapshots.

## Compose the provider

The computer provider selects the worker provider. There is no separate setting. `resolveWorkerProvider` in `packages/adapters/src/worker-composition.ts` returns E2B workers when `resolveSandboxProvider` resolves `SANDBOX_PROVIDER` to `e2b` with an `E2B_API_KEY`, and Docker workers on the computers' supervisor (`SANDBOX_SUPERVISOR_URL`, `SANDBOX_SUPERVISOR_TOKEN`) and `DATA_DIR` when it resolves to `docker`. `WORKER_TEMPLATE` only renames the guest image (`rakazo-worker-pi-native` by default). `createWorkerProvider` builds the adapter. Add your provider to both. Do not add a provider-specific environment variable when the provider's own SDK or the shared connection settings can express it. E2B reads `E2B_API_KEY` and `E2B_DOMAIN` itself.

Both composition roots, `apps/api/src/app.ts` and `apps/worker/src/index.ts`, call `composeWorkers(prisma, provider)`. It returns the lifecycle that bot and space deletion use, the reconciler's `reconcileWorkers`, and, with a provider, the executor's `runWorkers`.

Every deployment composes a provider: the app refuses to start without one unless `AGENT_RUNTIME=scripted`, the in-process test runtime. A run that needs files while its computer home is still a snapshot is refused (`home_move_pending`) until the home moves. Every run of a bot with a computer gets the file and shell tools, so in practice the bot's runs fail until then; only a bot without a computer runs without files.

## Mount the same volumes on the computer

A computer whose home is on volumes mounts the same bot and space volumes at the same paths as the workers, so a file a worker writes is the file the computer sees. The E2B computer in `packages/adapters/src/e2b-sandbox.ts` mounts them by name, links `/home/user/rakazo-home` to their root, and records `home: "volumes"` and a digest of its mounts in its metadata. A machine with another set of mounts is replaced. Nothing imports a snapshot over the volumes or exports them back.

The Docker computer in `packages/adapters/src/docker-sandbox.ts` sends the volume names and the workspace root to the supervisor's `POST /computers`. The supervisor validates them as it validates a worker's (`computerVolumeHome` in `infra/sandboxes/supervisor/src/computer-spec.ts`), mounts each at its `/workspace` path as a bind or a `Subpath` of the `appdata` volume, and records the labels `rakazo.home=volumes`, `rakazo.mounts=<digest>` and `rakazo.workspace=<root>`. A container whose digest differs is replaced; the home directory and the volumes outlive it, so nothing is archived. The workspace root, `/workspace` for a team computer and `/workspace/bots/<botId>` for a dedicated one, is where commands start and where the file routes resolve relative paths, so a relative path means the same file before and after the move. `/home/rakazo` stays on the `homes/<homeKey>` bind for dotfiles and browser profiles, and `~/workspace` links to the root. The supervisor never creates or deletes a volume directory.

## Move the existing homes

A team home holds `shared/` and `bots/<botId>/`, on Docker as on E2B: `bots/<botId>/` goes to that bot's private volume and `shared/` to the space volume. A dedicated home goes to its bot's private volume.

On E2B, `scripts/migrate-home-to-volumes.ts` moves one stopped computer's home from AgentHomeStore snapshots onto its volumes. It plans, copies, verifies every file by hash and mode, then adopts. The [operator guide](../../self-host-e2b-workers.md#move-existing-homes-onto-volumes) gives the procedure. The script and `scripts/migrate-skills-to-volumes.ts` reach each volume through `E2BVolumeFiles`, an implementation of `VolumeFiles` from `@rakazo/adapter-kit`. The API refuses to start while an E2B home is still on snapshots.

On Docker, homes and volumes are directories of the same `DATA_DIR` storage, so `packages/adapters/src/docker-home-migration.ts` renames instead of copying: `homes/<homeKey>/bots/<botId>` becomes `volumes/rakazo-<privateVolumeId>`, `homes/<homeKey>/shared` becomes `volumes/rakazo-<sharedVolumeId>`, and each root entry of a dedicated home except its dot entries moves into the private volume. Links and special files move as they are, and a link or a file in place of a team folder moves into the volume instead of replacing it, so a volume is always a real directory. It never follows a link. Every conflict is checked first. Then a marker file, `.rakazo-move-pending`, is created in the home directory without following links, the computer adopts its volumes under the move reservation, which it renews, the renames run, and the marker goes. While the marker exists, `provisionComputer` refuses to boot the computer (`ComputerBusyError` with reason `home_move_incomplete`), so a half-moved home never runs. The next sweep resumes only computers whose home has the marker, never a computer already on volumes without it, so later files in `~` stay where they are. A home in conflict with its volume (`DockerHomeConflict`, or `ENOTEMPTY`, `EEXIST`, `ENOTDIR`, `EISDIR`) is logged and skipped; any other error, such as `EXDEV`, `EACCES`, `EROFS`, `ENOSPC`, `EIO` or a database failure, stops the run. The Compose `migrate` service runs `scripts/migrate-docker-homes.ts` for every idle computer before the API and the worker start, and the idle job moves a busy one once it suspends.

## Prove the isolation

The guest is hostile, including the harness inside it. Containers share the host kernel, so Docker is a weaker boundary than a VM. Before users rely on a Docker worker, prove at least these points with code run inside a worker:

- It cannot read another bot's private volume, a shared volume of another space, or any host path outside its mounts.
- It cannot reach the Docker socket, the supervisor token, the controller, the database, or infrastructure credentials.
- It cannot reach another worker's processes or its localhost. Lane `c` proves this for E2B.
- It runs as an unprivileged user, with user namespaces, no added capabilities and no device access. Consider gVisor or Kata Containers for a stronger boundary.
- It cannot use another run's capability, or name its own model, endpoint or key. `packages/testkit/src/runtime-worker-hostile.test.ts` proves this at the controller for any provider, and lane `e-refusals` replays the model case live with `packages/testkit/src/worker-live/hostile-guest.ts`.

Reuse I1's attack list for E2B: direct mounts, guessed identifiers, links and path traversal.

## Test the adapter

Keep these tests deterministic and offline. Gate any test that needs a real Docker daemon, and list it with the other suites that need Docker. The Docker workers' run, fault and isolation suites, `packages/testkit/src/docker-worker*.docker.test.ts`, run with `VERIFY_DOCKER_WORKERS=1` once the worker image is built; the run suite also starts a Docker computer from `RAKAZO_COMPUTER_IMAGE` to check that it sees a worker's files at the same paths. On Docker Desktop, `host.docker.internal` reaches the host's localhost, which is accepted like open egress, and the Linux-only assertions are skipped.

- Test the adapter against a fake of its SDK, as `packages/adapters/src/e2b-worker.test.ts` does. Cover that `ensure` and `ensureVolume` create nothing after their deadlines, that `ensureVolume` returns the requested name twice, that `destroy` without a reference finds a worker by its attempt tag and returns `absent` once nothing is left, and that `connect` carries frames both ways and settles `exited` once the guest is gone.
- The controller suites, `packages/adapters/src/worker-lifecycle.test.ts` and `worker-volumes.test.ts`, run against `FakeWorkerProvider` and define the behavior your adapter must match: one destroy per release, leases held while a destroy is unconfirmed, and deletion records kept through the grace period.
- The `packages/testkit/src/runtime-worker-*.test.ts` suites run the real guest through `LocalWorkerProvider`. They cover the handshake, the hostile guest, stops, files and routing for any provider whose `connect` delivers the same frames.

The live lanes in `packages/testkit/src/cli/worker-live.ts` run against a real E2B deployment with `pnpm test:worker-live lanes --template <worker> --computer-template <computer> --out <dir>`. They call the E2B SDK directly. Port the lanes a new provider changes before you enable it: `a` and `f` for files on volumes, `b` and `c` for visibility and isolation between VMs, `g` and `g-timeout` for cleanup after faults, `h` and `home-move-fence` for the home move, and `e-refusals` for the hostile guest.
