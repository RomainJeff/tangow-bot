# Self-host sandbox / computer providers

`SANDBOX_PROVIDER` selects where bot computers run. Workspace bots share a Team Computer by
default; Private Computers are optional. See [computer runtime and isolation](./computer-runtime.md)
for the sharing and persistence contract.

## Quick pick

| Goal | Set | Also need |
| --- | --- | --- |
| Local Docker computers | `SANDBOX_PROVIDER=docker` | `SANDBOX_SUPERVISOR_TOKEN`, computer image, Docker socket for supervisor |
| UI only, no computers | `SANDBOX_PROVIDER=none` | No provider credential; published-images Compose still requires `SANDBOX_SUPERVISOR_TOKEN` |
| Managed remote desktop | `SANDBOX_PROVIDER=e2b` | `SANDBOX_SUPERVISOR_TOKEN` (published-images Compose), `E2B_API_KEY`, [E2B templates](./self-host-e2b-workers.md) |

Published-images [Compose](../infra/compose/docker-compose.images.yml) defaults to **`docker`**.
It always starts the supervisor and requires `SANDBOX_SUPERVISOR_TOKEN`, including for `none`
and remote providers. This stack credential does not replace a remote provider's API key.

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

Missing supervisor token is a **setup failure**: do not treat `sandbox: "none"` as success for this path.

Signup and local Docker computers work **without** an E2B (or other remote) account.

## `none`

Runs API/web without provisioning bot computers.

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
`docker` with pre-loaded images, or `none`.

## Verify a provider change

After changing provider or keys (from the published-images drop directory that
holds `docker-compose.images.yml` and `.env`):

```bash
docker compose --env-file .env -f docker-compose.images.yml up -d
curl -fsS http://127.0.0.1:3100/health
```

Confirm `sandbox` equals the intended provider (`e2b`).
HTTP 200 alone does not verify a remote provider: a missing API key falls back to `sandbox: "none"`.
A present but invalid key still reports the selected provider. Open a bot's computer to verify
provisioning and desktop access.
