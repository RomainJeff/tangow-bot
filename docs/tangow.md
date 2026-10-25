# Tangow

Tangow runs **directly on the server**, from a Rakazo source checkout. It updates the application
and the computer builds for the configured provider. Run `./tangow` or `pnpm tangow`; it does not
operate the published-image installer or install E2B infrastructure.

```bash
./tangow status
./tangow update --dry-run
./tangow update
```

`update` fetches `origin/main`, fast-forwards a clean checkout onto `main`, and builds the application.
It reads the ignored `.env.e2b.compose.json` used by the deployment:

- With that override, it preserves E2B settings, installs frozen build dependencies, builds and
  pushes the desktop image, then rebuilds the worker and desktop templates. The desktop template
  uses the pushed image's immutable digest.
- Without it, it builds the Docker computer and supervisor images alongside the application.
  Source Compose forces Docker; a `SANDBOX_PROVIDER` value in `.env` alone does not enable E2B.

It then starts the services and checks the actual API revision and provider, application images,
web readiness and, on Docker, the supervisor image. It never resets local commits or deletes data.

## Configure once

The deployment needs Git, Docker Compose, a configured `.env` and Node.js. E2B builds need a Node
version supported by `package.json` and pnpm 9. Enable Corepack after installing supported Node:

```bash
corepack enable
```

Tangow installs frozen dependencies before template builds. For Docker-to-E2B setup, install them
first with `CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile`.

Optional defaults belong in **`.env.tangow.json`**, which is ignored by Git:

```json
{
  "sudo": true,
  "computerImage": "registry.example.com/rakazo-computer:local"
}
```

`sudo` uses passwordless `sudo -n` for Docker and for reading a root-owned E2B override. Git always
runs as the checkout owner. That owner must be able to replace `.env` and write to the checkout.
Keep this config readable by that owner. Credentials stay in the existing private E2B override.

`computerImage` selects a pushable registry image that the E2B builder can pull. When omitted,
Tangow infers the repository from `rakazo/computer:local`'s existing registry digest and uses its
`:local` tag. If no digest exists, it asks you to configure an image before changing Git or services.
`--sudo` and `--computer-image` can also supply these settings for one invocation.

To select a different source deployment on the same server:

```bash
./tangow --path /srv/rakazo status
```

## Other commands

```bash
./tangow restart
./tangow logs worker
./tangow logs api --follow
./tangow computers build
./tangow cleanup --dry-run
./tangow cleanup --yes
```

`restart` restarts the existing application containers without rebuilding and verifies the same
revision and container images. `status` shows checkout and runtime revisions separately. Logs
show the last 100 lines unless followed; they are operator output and may contain private data.

`computers build` rebuilds only the configured provider's images/templates. An E2B build requires
a clean checkout matching the running API and worker revision; use `update` for a new revision.

New workers and computers use the new builds. To replace existing computers, open
**Settings > Computer > Update all computers**. Busy computers are skipped and reported for retry.
Tangow does not interrupt them.

Cleanup removes unused build cache and images, including images useful for manual rollback. It
never prunes containers or volumes. Run it after checking the deployment. `--dry-run` on any
command describes the operation without running external commands or changing files.

## Switch Docker to E2B

Tangow reuses the [existing setup and migration command](self-host-e2b-workers.md), including its
backups, readiness checks and resumable home migration. Deploy the current revision, configure a
registry image as above, and finish active work and release computer control first.

```bash
./tangow provider e2b --dry-run
./tangow provider e2b
```

Setup asks for an E2B domain and a hidden key, or keeps saved values. For unattended operation,
use existing private configuration or `E2B_DOMAIN` and `E2B_API_KEY` on the server and add
`--migrate-existing` to consent to the one-way home move. Sudo must permit preserving the named
`E2B_*` and `WORKER_TEMPLATE` variables; their values never enter command arguments. Successful
setup saves the selected registry image and sudo preference in `.env.tangow.json` for later updates.

Originals and backups are retained. Unsupported home entries stay in originals and backups,
outside the new volumes; the setup guide documents the scope. `provider docker` confirms an
existing Docker deployment but refuses E2B because reverse home migration is unsupported.

## Recover an interrupted operation

A failed application build leaves running services alone, although Git may have advanced. A later
failure may leave published E2B templates or restarted services in place. Tangow identifies the
failed step and never claims a template or database rollback. Fix the problem and rerun `update`.
Keep template and application upgrades within a maintenance window.

If home migration fails, rerun the same `provider e2b` command. Do not manually start services while
`.env.e2b.upgrade.json` exists; other Tangow mutations refuse an incomplete migration.

Only one Tangow mutation runs per checkout. After interruption, inspect the PID in
`.env.tangow.lock` and confirm the process has stopped before removing a stale lock. E2B setup has
its own `.env.e2b.setup.lock`; follow its recovery instructions. Keep environment files, overrides,
journals and backups private.
