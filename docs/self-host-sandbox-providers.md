# Self-host sandbox / computer providers

`SANDBOX_PROVIDER` selects where bot computers run. Workspace bots share a Team Computer by
default; Private Computers are optional. See [computer runtime and isolation](./computer-runtime.md)
for the sharing and persistence contract.

## Quick pick

| Goal | Set | Also need |
| --- | --- | --- |
| Local Docker computers | `SANDBOX_PROVIDER=docker` | `SANDBOX_SUPERVISOR_TOKEN`, computer image, Docker socket for supervisor |
| Managed remote desktop | `SANDBOX_PROVIDER=e2b` | `SANDBOX_SUPERVISOR_TOKEN` (published-images Compose), `E2B_API_KEY`, [E2B templates](./self-host-e2b-workers.md) |

Published-images [Compose](../infra/compose/docker-compose.images.yml) defaults to **`docker`**.
It always starts the supervisor and requires `SANDBOX_SUPERVISOR_TOKEN`, including for `e2b`.
This stack credential does not replace a remote provider's API key.

The API and worker refuse to start when the provider cannot run computers: an empty
`SANDBOX_PROVIDER`, `e2b` without `E2B_API_KEY`, or `docker` in production without
`SANDBOX_SUPERVISOR_TOKEN`. The error names the missing setting. `none` was removed; there is no
mode without computers.

## `docker` (in-stack supervisor)

Compose starts a **sandbox supervisor** (from the app image) on the internal
network (port `7091` in published-images). It creates sibling **computer**
containers from `RAKAZO_COMPUTER_IMAGE` + `RAKAZO_COMPUTER_IMAGE_TAG`.

Requirements:

- Non-empty `SANDBOX_SUPERVISOR_TOKEN` (distinct from auth / screen / encryption secrets)
- Reachable computer image (GHCR default or your mirror; on arm64 pin multi-arch tags for both app and computer)
- Docker Engine available to the supervisor (socket mount on the Compose path)

Verify:

```bash
curl -fsS http://127.0.0.1:3100/health
# expect sandbox: docker
```

Signup and local Docker computers work **without** an E2B (or other remote) account.

### Homes on volumes

Each bot has a private volume and each space a shared one, as directories of `DATA_DIR/volumes/`.
A run that uses files works in a worker container that mounts them at `/workspace/bots/<botId>`
and `/workspace/shared`. The computer mounts the same volumes at the same paths, so a file a
worker writes is the file the computer shows. The computer's workspace starts at `/workspace` on a
Team Computer and at `/workspace/bots/<botId>` on a Private Computer; `~/workspace` links there.
`/home/rakazo` keeps the dotfiles and the browser profiles in `DATA_DIR/homes/`.

The API, the worker, the `migrate` service and the supervisor must see the same `DATA_DIR`
storage: the Compose files mount the same `/data` (the `../../data` bind, or the `appdata`
volume) in each. `DATA_DIR/homes` and `DATA_DIR/volumes` must be on the same filesystem.

Homes created before volumes move once, by renaming their folders into the volumes: a Team
Computer's `bots/<botId>/` and `shared/`, and everything at the root of a Private Computer except
its dot entries. The `migrate` service moves every idle computer before the API and the worker
start (`scripts/migrate-docker-homes.ts` for a source checkout). A computer still running moves
when it next goes to sleep. Nothing is copied, and a home on volumes stays there. A home whose
folder and volume both hold files is left as it is and logged with its computer id, and the
others still move.

On Docker Desktop (macOS, Windows), a worker can reach the host's localhost through
`host.docker.internal`, so the API, web and Postgres published on `127.0.0.1` answer it. They still
require their token, session or password. This is accepted like the workers' open egress to the
internet.

## Remote provider

Set `SANDBOX_PROVIDER=e2b` and `E2B_API_KEY` for hosted E2B sandboxes. Each bot run then works in
its own E2B worker VM. Build the worker and computer templates and move existing homes as
[E2B workers](./self-host-e2b-workers.md) describes.

Daytona and Box were removed: the API and worker refuse to start with
`SANDBOX_PROVIDER=daytona` or `box`. Before upgrading, let those computers go idle so their
workspace is saved; work since the last save is lost. After switching to `docker` or `e2b`, each
computer is recreated on the new provider at its next boot. Rakazo no longer stops the old
Daytona sandboxes or Box machines, so delete them in the vendor's console.

Remote paths still need a working API/worker; they do not replace Postgres or
the web UI. They require egress to the provider. For air-gapped hosts prefer
`docker` with pre-loaded images.

## Verify a provider change

After changing provider or keys (from the published-images drop directory that
holds `docker-compose.images.yml` and `.env`):

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d
curl -fsS http://127.0.0.1:3100/health
```

Confirm `sandbox` equals the intended provider (`e2b`).
A missing API key stops the API at startup. A present but invalid key still reports the selected
provider. Open a bot's computer to verify
provisioning and desktop access.
