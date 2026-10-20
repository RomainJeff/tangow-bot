# How to add a worker provider

This guide adds a provider that runs one worker per run attempt and mounts bot and space volumes. The example is Docker. Read the [P1 handoff](P1-handoff.md) first: it defines the contract every provider implements.

The worker contracts do not depend on E2B. A provider is an adapter behind `WorkerProvider`, plus two policy switches that say which computer kinds may move their home onto volumes. Nothing else in the controller changes.

## Know what the controller already guarantees

The controller decides ownership, fences and leases before it calls the provider. Your adapter never checks that a volume belongs to the bot, and it never chooses a path. It receives a `WorkerSpec` that is already authorized:

```ts
interface WorkerSpec {
	attemptId: string;
	runId: string;
	botId: string;
	mounts: Array<{ volumeRef: string; path: string; access: "rw" | "ro" }>;
	ttlSeconds: number;
	ensureDeadline: Date;
}
```

`volumeRef` is the volume name passed to `ensureVolume`, which must return that same name. `path` is `/workspace/bots/<botId>` or `/workspace/shared`. Mount each volume at exactly that path.

## Implement `WorkerProvider`

Create the adapter in `packages/adapters/src/`, next to the existing sandbox adapters. Keep every vendor call in this file and in its composition root, as `AGENTS.md` requires.

Each method has a rule that the controller depends on for safety:

| Method | Rule | Docker example |
| --- | --- | --- |
| `describe()` | Report `readOnlyMounts` truthfully. If the provider cannot enforce a read-only mount, report `false`, and the controller refuses `ro` grants. | Bind mounts and named volumes accept `:ro`, so report `true`. |
| `ensure(spec)` | Create one worker tagged with `spec.attemptId` and return its reference. The controller calls it once per attempt. Never create the worker after `spec.ensureDeadline`, the instant the controller stops waiting for it. | Create a container with the label `rakazo.attempt=<attemptId>`, mount each volume at its `path`, and stop it after `ttlSeconds`. Cancel creation when the deadline passes. Return the container id. |
| `prepare(ref, spec)` | Finish fallible setup after the reference is recorded. It must be idempotent. | Start the container, then wait until the mounts are visible and the runner answers. |
| `destroy({ attemptId, providerRef })` | Remove every worker tagged with `attemptId`, with or without a reference. Return `absent` when none is left. Never treat "not found" as an error. | Remove every container with the label `rakazo.attempt=<attemptId>`, forced. Leave the volumes in place. |
| `ensureVolume({ name, ensureDeadline })` | Create the named volume, or return it. Always return `name` as its reference. Stop submitting creates before `ensureDeadline`. Server processing must finish within the one-hour deletion grace period after it, including when the controller dies or loses the response. | Create the volume `name` if it is missing, and return `name`. Bound the request by the deadline and verify the server completion bound after a lost response. |
| `deleteVolume({ providerRef })` | Delete the named volume, even if `ensureVolume` never returned. One already gone is not an error. | Remove the volume `providerRef` if it exists. |

Volumes outlive every run. Before calling `ensureVolume`, the controller commits an `ensureUntil` deadline under the volume row lock. The name is always `rakazo-<volumeId>`, so a reference can be recovered without a provider response. Deleting a bot or a space deletes its volume rows and records every volume in `volume_deletions` in the same transaction, including rows with no recorded reference. The record preserves the latest provisioning deadline. Concurrent provisioners extend that deadline under the same lock.

The lifecycle's `sweepVolumes` waits until that deadline before deleting the named volume. It retains the record for one hour after the latest deadline and repeats the idempotent delete on every eligible sweep. Only a successful delete after that grace period clears the record. Even successful provisioning may delay the first deletion by the remaining deadline, currently up to 15 minutes.

E2B stops sending creates a minute early and bounds the client request with the remaining time and an abort signal. Client cancellation cannot stop server processing of an accepted create, especially after the controller dies. The grace period assumes every accepted create finishes within one hour after its persisted ensure deadline. A create that finishes later, after the final successful sweep, can leak a volume. Prove this server latency bound for a new provider, or increase the shared grace period before enabling it. Cleanup also needs a running reconciler and a provider that eventually accepts deletes.

A provisioning response that arrives after owner deletion refreshes the deletion record. Each insert or refresh takes its generation from a database sequence, which never resets on reinsertion. A sweeper clears only the generation it deleted, so concurrent sweepers cannot clear a fresh record. The sweep never discovers deletion candidates by listing the provider's volumes, so other deployments' volumes stay untouched. Records wait while no provider of their kind is configured.

Respect the TTL at the provider. If the controller never confirms destruction, the TTL is the last bound on a worker that still holds a volume. The TTL is one hour, the most E2B allows by default. A provider whose deployment allows less caps the worker's lifetime at that limit and logs a warning, as `E2BWorkerProvider` does with `maxTimeoutMs`.

## Enable the computer kind

Two switches decide which computer kinds may move a home from AgentHomeStore snapshots to volumes. Change both in the same pull request.

1. In `packages/core/src/worker-plan.ts`, set the kind to `"worker"` in `WORKER_SUPPORT`:

	```ts
	export const WORKER_SUPPORT = {
		e2b: "worker",
		docker: "worker",
		// ...
	} as const satisfies Record<SandboxKind, "worker" | "in_process">;
	```

2. Add a migration that extends `computers_home_storage_check`. Drop and recreate the constraint as `NOT VALID`, then validate it in a second migration, as `20261019120005_validate_worker_checks` does:

	```sql
	ALTER TABLE "computers" DROP CONSTRAINT "computers_home_storage_check";
	ALTER TABLE "computers" ADD CONSTRAINT "computers_home_storage_check" CHECK (
	    "homeStorage" = 'snapshot' OR ("homeStorage" = 'volumes' AND "kind" IN ('e2b', 'docker'))
	) NOT VALID;
	```

A new `SandboxKind` fails the build until it has an entry in `WORKER_SUPPORT`, so a kind cannot be forgotten.

`WORKER_SUPPORT` is keyed by the computer kind. That fits a deployment where workers and the computer use the same provider. To run Docker workers next to an E2B computer, key it by the worker provider instead. P1 does not do that.

## Compose the provider

`WORKER_PROVIDER` selects the provider and `WORKER_TEMPLATE` its guest image (`rakazo-worker-pi` by default). `resolveWorkerProvider` in `packages/adapters/src/worker-composition.ts` parses them, and `createWorkerProvider` builds the adapter. Add your provider to both. Do not add a provider-specific environment variable when the provider's own SDK or the connection settings can express it: E2B reads `E2B_API_KEY`, and `E2B_DOMAIN` or `E2B_API_URL` for a self-hosted endpoint.

Both composition roots, `apps/api/src/app.ts` and `apps/worker/src/index.ts`, call `composeWorkers(prisma, provider)`. It returns the lifecycle that bot and space deletion use, and, with a provider, the executor's `runWorkers` and the reconciler's `reconcileWorkers`.

A deployment that composes no provider keeps every run in process. `plan` then answers `no_worker_provider` without a query.

## Migrate the existing homes

A computer keeps `homeStorage = 'snapshot'` until `adoptVolumeHome` moves it. Follow the AgentHomeStore procedure in the handoff for each computer: create the volume rows, provision them, copy the files, then adopt.

The Docker team home is one directory per computer, holding `shared/` and `bots/<botId>/`. Copy `bots/<botId>/` into that bot's private volume and `shared/` into the space volume. Never copy the whole team home into every private volume. Keep the original directory until the copy is verified.

A Docker computer that runs with the `local-fs` store reports `mounted` today: its home directory is the container disk. After adoption it reports `volumes`, and the computer mounts the same bot and space volumes at the same paths as the workers.

## Prove the isolation

The guest is hostile, including its Pi process. Containers share the host kernel, so Docker is a weaker boundary than a VM. Before users rely on a Docker worker, prove at least these points with code run inside a worker:

- It cannot read another bot's private volume, a shared volume of another space, or any host path outside its mounts.
- It cannot reach the Docker socket, the supervisor token, the controller, the database, or infrastructure credentials.
- It runs as an unprivileged user, with user namespaces, no added capabilities and no device access. Consider gVisor or Kata Containers for a stronger boundary.

I1 defines the equivalent proofs for E2B. Reuse its attack list: direct mounts, guessed identifiers, links and path traversal.

## Test the adapter

- Run the worker suites with your provider in place of `FakeWorkerProvider`. `packages/adapters/src/worker-lifecycle.test.ts` shows the behavior the controller expects.
- Test that `destroy` without a reference finds a worker by its attempt tag, and returns `absent` once nothing is left.
- Test that `ensure` and `ensureVolume` respect their deadlines and that `ensureVolume` returns the requested name twice.
- Lose a create response, delete the owner before recording its reference, and verify that a restarted controller waits out the provisioning deadline, re-deletes a create that lands during the grace period, and clears the record only after that period. Race two sweepers with a delayed provisioning response and verify that an older sweep keeps a fresh deletion record.
- Keep these tests deterministic and offline. Gate any test that needs a real Docker daemon, and list it in the harness like the other suites that need Docker.
