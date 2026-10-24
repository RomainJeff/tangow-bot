# Self-host E2B workers

On an E2B deployment, each bot run works in its own temporary E2B VM, called a worker. The worker
runs the bot's Pi harness with native file and `bash` tools on the bot's volumes. Rakazo tools
(computer, browser, memory, integrations) stay on the API and worker processes, and the model key
never enters the worker. The worker is destroyed when the run attempt ends.

A run goes to a worker when `SANDBOX_PROVIDER=e2b` and the bot's computer keeps its home on volumes.
Every other run stays in process, as on `docker`, `none` and the trusted local computer, which run
no workers. Docker workers are a later exploration
([#317](https://github.com/RomainJeff/rakazo-bot/issues/317)).

To add a worker provider, see
[how to add a worker provider](./implementation/pi-e2b/adding-a-worker-provider.md).

## Prerequisites

- An E2B account, or a self-hosted E2B deployment, with volumes enabled. Workers and computers
  mount the bot and space volumes.
- A checkout of Rakazo at the commit your API and worker images run. For published images, that
  commit is the `revision` that `GET /health` reports.
- Node.js 22.22.2 or a later 22, 24, or 26 and later, with pnpm, on a host that reaches the E2B
  API, to build the templates. pnpm refuses other Node versions. For the computer template, Docker
  and a registry the E2B host can pull from.

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
   pnpm --filter @rakazo/agent-run-worker template:build
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
   pnpm --filter @rakazo/computer-e2b-template template:build \
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

A computer created before this release keeps its home in snapshots under `DATA_DIR`, and its runs
stay in process. Move each such home once with `scripts/migrate-home-to-volumes.ts`. The move is
one way: Rakazo has no command to move a home back to snapshots. The snapshot stays in `DATA_DIR`
as the pre-move original, and nothing writes to it after the move.

The commands below run in a one-off `api` container of the production Compose stack, which already
has `DATABASE_URL`, `DATA_DIR` and the E2B variables. Set `compose` once:

```bash
compose="docker compose --env-file .env -f infra/compose/docker-compose.prod.yml"
```

For published images, run from the directory that holds `docker-compose.images.yml` and set
`compose="docker compose --env-file .env -f docker-compose.images.yml"` instead.

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

## Verify

1. Check that `GET /health` reports `"sandbox": "e2b"`. A missing `E2B_API_KEY` reports `"none"`.

   ```bash
   curl -fsS https://app.example.com/health
   ```

2. Send a message to a bot whose computer is on volumes, and wait for the reply. Each model request
   of a worker run logs `agent.worker.model_request` with the run's `runId` and `attemptId`. A run
   that stays in process logs none:

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
