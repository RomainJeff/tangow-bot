# Self-host E2B workers

On an E2B deployment, each bot run works in its own temporary E2B VM, called a worker. The worker
runs the bot's Pi harness with native file and `bash` tools on the bot's volumes. Rakazo tools
(computer, browser, memory, integrations) stay on the API and worker processes, and the model key
never enters the worker. The worker is destroyed when the run attempt ends.

Every run goes to a worker. A Docker deployment runs its workers as containers instead
([self-host](self-host.md)).

Worker providers implement the
[`WorkerProvider` contract](../packages/adapter-kit/src/worker-provider.ts).

## Prerequisites

- An E2B account, or a self-hosted E2B deployment, with volumes enabled. Workers and computers
  mount the bot and space volumes.
- A clean checkout matching the locally built `rakazo/app:local` image. For ordinary setup this
  is also the running revision. After a Tangow E2B home preflight refusal, keep its prepared target
  image, `.env` revision and completed startup migrations while setup upgrades the older services.
- Node.js 22.22.2 or a later 22, 24, or 26 and later, with pnpm, on a host that reaches the E2B
  API, to build the templates. pnpm refuses other Node versions. For the computer template, Docker
  and a registry the E2B host can pull from.

## Configure an existing source deployment with one command

Run setup on the deployment host from the checkout matching the verified local application image.
It builds the lightweight Pi worker and desktop computer templates separately, upgrades existing
Docker or snapshot-based E2B homes, and starts the application only after the upgrade is complete.
It targets `infra/compose/docker-compose.yml`; it does not install E2B or configure other Compose
layouts.

Install the Node and pnpm versions listed above and install dependencies first. `CI=true` prevents
pnpm from leaving a noninteractive reinstall waiting at its confirmation prompt:

```bash
CI=true pnpm install --frozen-lockfile
node infra/compose/setup-e2b.mjs --computer-image registry.example.com/rakazo-computer:local --dry-run
node infra/compose/setup-e2b.mjs --computer-image registry.example.com/rakazo-computer:local
```

Docker must be accessible to the current user, with push access to a registry the E2B builder can
pull from. Runtime sources must have no uncommitted changes. The script verifies the locally built application image matches the checkout before publishing
templates. If Tangow update stopped at the E2B home preflight, its prepared revision and startup
migrations allow setup to use that new image while the older API is still deployed. After migration
consent, setup stops the older API/worker before publishing templates and starts the prepared
revision only when the home upgrade completes. The registry argument applies only to the desktop image;
the Pi worker has its own Node-based builder. `WORKER_TEMPLATE` can select another worker name.

The terminal asks for the E2B domain and API key. Key entry is hidden; Enter keeps a saved value.
For a custom endpoint layout, set both `E2B_API_URL` and `E2B_SANDBOX_URL`. Both must be reachable
from the host and the API/worker containers. A loopback address inside an application container
points at that container, not the E2B host. Setup probes volume API access from both containers
before building. Keep the template upload port private.

### Upgrade existing bots

Finish or cancel active generations and release computer control before setup. The script refuses
active runs, live computer leases, concurrent maintenance and unsupported source providers. It
uses the actual source provider to checkpoint and stop each old computer; it does not treat an old
Docker reference as an E2B sandbox.

For team computers, setup inspects and migrates only `bots/` and `shared/`; it does not traverse
other home folders. Dedicated computer homes are already a single bot's private workspace, so
their root moves to that bot's volume. Setup asks for consent to the one-way move and displays one
warning: other home entries and non-transferable workspace entries, including symbolic links,
remain **only in the original home and backup**. They are not available to the new workers.
There is no separate exclusion prompt. The private plan is `.env.e2b.plan.json`; migration
manifests detail skipped entries within the inspected workspace.

After consent, setup builds the templates, stops API and worker, rechecks that the deployment is
idle, and writes a verified Postgres dump under `backups/e2b-<id>/`. It pauses and checkpoints the
source computers, then archives application data in that backup directory before adopting any
volumes. It migrates team homes before dedicated homes, verifies copied files and modes, and
copies legacy user skills to the shared volumes. Original homes and old machines are retained.
Detailed migration manifests are stored under `DATA_DIR/e2b-upgrade/`. The full data backup also
retains folders outside the migration scope; backup traversal is independent of migration planning.

A Docker computer whose home is already on Docker volumes (`DATA_DIR/volumes/rakazo-<volume-id>`)
is carried the same way: setup stops it, copies the regular files of each of its volumes into an
E2B volume of the same name, verifies their SHA-256 and mode, then switches the volume and the
computer to E2B. A space's shared volume is copied once. Symbolic links, special files, empty
folders and files over 1 GiB are never followed or copied; the plan lists them, a large file as
`too_large`. Dotfiles and browser profiles in
`DATA_DIR/homes` stay behind, as for a team home, so each bot starts E2B with a fresh browser and
must sign in again to the sites it used. The local volume directories are left in place:
delete them once the bots work on E2B. See
[Carry Docker volumes to E2B](#carry-docker-volumes-to-e2b) to run it by hand.

For noninteractive operation, supply `E2B_DOMAIN` and `E2B_API_KEY` through the environment or
existing private configuration. Explicitly consent to the home move with `--migrate-existing`.
The same workspace scope and retention warning apply in noninteractive mode:

```bash
node infra/compose/setup-e2b.mjs --computer-image registry.example.com/rakazo-computer:local \
  --migrate-existing
```

A successful setup requires every existing computer home to use E2B volumes, API and worker to be
ready, and a temporary worker VM to read its guest and skills and perform a file round trip on a
private volume. Setup deletes that VM and its probe file afterward. It does not test a real model
credential or renew expired MCP authorization; use [Verify](#verify) for a conversation-level check.

### Configuration and recovery

Credentials are stored in `.env.e2b.compose.json`, ignored by Git with mode `0600`; the base `.env`
is unchanged. The source Compose file forces Docker without this override. Use the full command
printed by setup for subsequent deployments:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml \
  -f .env.e2b.compose.json up -d --pull never
```

The private `.env.e2b.upgrade.json` journal records progress. If preparation or migration fails,
API and worker remain stopped, E2B configuration stays in place, and setup reports an incomplete
upgrade. Resolve the reported issue and rerun the same setup command to resume. It reuses the
backup and already-adopted homes, retains previous manifests and restarts services only after all
homes and skills are ready. Do not delete the journal or manually start services during a partial
upgrade. An expired preparation reservation is cleared safely on retry.

A startup or verification failure retains the new E2B configuration and stops API/worker, even
before home preparation starts. Fix the failure and rerun setup to recover forward. Configuration,
code, databases and published template builds are never rolled back. Protect the override, journal, plans, manifests and backups as private deployment data;
never paste their contents into commits, issues or public logs.

## Build the templates

Build both templates once per deployment, from the same commit as the API and worker images, and
rebuild them on every upgrade. Rakazo publishes no shared template. The controller refuses a
worker whose protocol version or harness differs from its own.

Run the builds where the E2B API and its file upload port are reachable. On a self-hosted E2B, that
is usually the E2B host itself. The E2B SDK reads `E2B_API_KEY` and `E2B_DOMAIN`, or `E2B_API_URL`
and `E2B_SANDBOX_URL`, from the environment.

1. Build the worker template from `apps/agent-run-worker/template`. It bundles the guest and builds
   the template `rakazo-worker-pi-native`:

   ```bash
   pnpm install
   pnpm --filter @tangow/agent-run-worker template:build
   ```

   To build it under another name, pass `--name <name>` and set `WORKER_TEMPLATE` to that name.

   If the E2B host has no checkout or an older Node, bundle the build on another machine and run
   it on the host with Node 22 or later:

   ```bash
   pnpm test:worker-live:bundle
   # copy packages/testkit/dist/worker-live to <dir> on the E2B host, then on the host:
   node <dir>/bin/worker-live.mjs template --name rakazo-worker-pi-native \
     --guest <dir>/guest/agent-run-worker.mjs
   ```

2. Build the computer template `desktop` from `infra/sandboxes/computer/e2b`. Follow its
   [README](../infra/sandboxes/computer/e2b/README.md): build and push the computer image for
   amd64, then build the template from the image digest:

   ```bash
   pnpm --filter @tangow/computer-e2b-template template:build \
     --image <registry>/rakazo-computer@sha256:<digest>
   ```

A build under an existing name adds a new build to that template. New workers and computers use it.

## Configure the environment

Set these in the `.env` that the API and worker read:

```env
SANDBOX_PROVIDER=e2b
E2B_API_KEY=replace-with-your-e2b-key
# Self-hosted E2B only:
# E2B_DOMAIN=e2b.example.com
# Only when you built the worker template under another name:
# WORKER_TEMPLATE=rakazo-worker-pi-native
```

For a self-hosted E2B, set `E2B_DOMAIN`. The SDK derives the API and sandbox endpoints from it.
`E2B_API_URL` moves only the API endpoint, which also creates and deletes volumes. With it, also
set `E2B_SANDBOX_URL`, or sandbox calls go to E2B's hosted domain.

Recreate the `api` and `worker` services with the `docker compose ... up -d` command you deploy with.
The rest of the E2B setup is in the [provider setup guide](./self-host-sandbox-providers.md).

## Move existing homes onto volumes

A new space on E2B gets a team computer whose home is on volumes. A dedicated computer created
later takes the storage of its space's team computer. Its runs go to workers with no move.

Until upgraded, a computer created before this release keeps its home in snapshots under `DATA_DIR`,
and the API refuses to start. The setup command above moves these homes as part of the upgrade. The following manual commands are for controlled recovery or standalone moves with `scripts/migrate-home-to-volumes.ts`. The move is
one way: Rakazo has no command to move a home back to snapshots. The snapshot stays in `DATA_DIR`
as the pre-move original, and nothing writes to it after the move.

The commands below run in a one-off `api` container of the production Compose stack, which already
has `DATABASE_URL`, `DATA_DIR` and the E2B variables. Set `compose` once:

```bash
compose="docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
```

1. List the E2B computers still on snapshots. Write down each id, its scope and its space:

   ```bash
   $compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
     "SELECT id, scope, \"spaceId\" FROM computers WHERE kind = '\''e2b'\'' AND \"homeStorage\" = '\''snapshot'\'' ORDER BY \"spaceId\", scope DESC"'
   ```

2. Move the homes one computer at a time. In each space, move the team computer before its
   dedicated computers, so that the shared folder is on the space volume before a dedicated bot's
   worker mounts it.

3. Make sure that the computer is idle. Its state must be `stopped` or `suspended`, with no run and
   no user in control. A computer suspends after `SANDBOX_IDLE_MS` without use. A team move is
   also refused while a worker of its space runs.

4. Run a dry run. It creates nothing and prints the plan, or the reason the move would be refused:

   ```bash
   $compose run --rm --no-deps api pnpm exec tsx scripts/migrate-home-to-volumes.ts \
     --computer <computer-id> --dry-run
   ```

5. Run the move with a manifest path that does not exist yet. The move creates the volumes, copies
   the files, reads each one back to compare its SHA-256 and mode, then switches the computer to
   volumes:

   ```bash
   $compose run --rm --no-deps api pnpm exec tsx scripts/migrate-home-to-volumes.ts \
     --computer <computer-id> --manifest /data/home-move-<computer-id>.json
   ```

   The command prints a JSON report and exits with code 1 when it refuses. Keep the manifest. It
   lists every moved file with its volume, SHA-256 and mode.

6. After a team move, copy the space's existing user skills to its shared volume. Run it while no
   bot of the space runs. The copy never deletes or replaces the originals:

   ```bash
   $compose run --rm --no-deps api pnpm exec tsx scripts/migrate-skills-to-volumes.ts \
     --space <space-id> --dry-run
   $compose run --rm --no-deps api pnpm exec tsx scripts/migrate-skills-to-volumes.ts \
     --space <space-id>
   ```

Both scripts take `--template <name>` when your worker template is not `rakazo-worker-pi-native`.

If the move refuses with `not_copied`, the home holds entries that a volume cannot hold, such as
links or files outside every bot folder. The report lists them. Fix them, or rerun with
`--leave-unmapped` to leave them in the snapshot only.

Do not deploy while a move runs. If a move stops before it finishes, its reservation expires after
one minute and Rakazo releases it. To release it at once, run the script with
`--computer <computer-id> --clear-stale-move`. Then rerun the move with a new manifest path. It
resumes the copy.

### Carry Docker volumes to E2B

For a Docker computer whose home is on Docker volumes, with the API and worker stopped:

1. Stop the computer and list what each volume would copy and leave behind:

   ```bash
   $compose run --rm --no-deps api pnpm exec tsx scripts/setup-e2b-homes.ts --prepare <computer-id>
   $compose run --rm --no-deps api pnpm exec tsx scripts/setup-e2b-homes.ts --inspect --plans
   ```

2. Carry it. The command prints a JSON report and exits with code 1 when it refuses:

   ```bash
   $compose run --rm --no-deps api pnpm exec tsx scripts/carry-docker-volumes-to-e2b.ts \
     --computer <computer-id>
   ```

In each space, carry the team computer before the space's dedicated computers: it carries the
shared volume, which their bots' workers also mount. If the command stops, rerun it: volumes already on
E2B are skipped and the copy resumes. It refuses with `volume_not_empty` when the E2B volume holds
files it did not copy, and with `volume_changed` when a local file changed during the copy. The
local directories under `DATA_DIR/volumes` are never changed or deleted; delete them yourself once
the bots work on E2B.

## Verify

1. Check that `GET /health` reports `"sandbox": "e2b"`. A missing `E2B_API_KEY` reports `"none"`.

   ```bash
   curl -fsS https://app.example.com/health
   ```

2. Send a message to a bot whose computer is on volumes, and wait for the reply. Each model request
   of a worker run logs `agent.worker.model_request` with the run's `runId` and `attemptId`:

   ```bash
   $compose logs api worker | grep agent.worker.model_request
   ```

   During the run, the E2B dashboard lists a sandbox of the worker template with the metadata
   `rakazo: worker` and the `attemptId`.

3. After the reply, check that the E2B dashboard lists no sandbox with the metadata
   `rakazo: worker`. The bot's computer, with the metadata `rakazo: computer`, can stay until it
   suspends.

## Limits

- The worker VM has no egress filter. Code in the worker, including a modified Pi, can send any
  file of the bot's volume and of the space's shared volume anywhere. The worker holds no model key
  or Rakazo secret.
- A worker lives at most one hour, the E2B sandbox timeout. A run that outlasts it loses its VM and
  continues in a new attempt. A deployment that allows a shorter sandbox timeout caps the worker at
  that limit and logs a warning.
- A cancel reaches a running worker at the run's next lease heartbeat, up to 60 seconds later.
  Native work in the worker keeps running until then.
- Pause and resume of an E2B worker while a run waits for an approval are not verified.
