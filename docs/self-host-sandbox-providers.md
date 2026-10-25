# Self-host sandbox / computer providers

`SANDBOX_PROVIDER` selects where bot computers run. Workspace bots share a Team Computer by
default; Private Computers are optional. See [computer runtime and isolation](./computer-runtime.md)
for the sharing and persistence contract.

## Quick pick

| Goal | Set | Also need |
| --- | --- | --- |
| Local Docker computers | `SANDBOX_PROVIDER=docker` | `SANDBOX_SUPERVISOR_TOKEN`, computer image, Docker socket for supervisor |
| Managed remote desktop | `SANDBOX_PROVIDER=e2b` | `E2B_API_KEY`, [E2B templates](./self-host-e2b-workers.md) |

The source-checkout [Compose](../infra/compose/docker-compose.yml) runs **`docker`**; the
[production Compose](../infra/compose/docker-compose.prod.yml) defaults to **`e2b`**.

The API and worker refuse to start when the provider cannot run computers: an empty
`SANDBOX_PROVIDER`, `e2b` without `E2B_API_KEY`, or `docker` in production without
`SANDBOX_SUPERVISOR_TOKEN`. The error names the missing setting. `none` was removed; there is no
mode without computers.

## `docker` (in-stack supervisor)

Compose starts a **sandbox supervisor** (from the app image) on the internal
network (port `7091`). It creates sibling **computer** containers from the computer image
built by `pnpm sandbox:build`.

Requirements:

- Non-empty `SANDBOX_SUPERVISOR_TOKEN` (distinct from auth / screen / encryption secrets)
- The computer image built on the host (`pnpm sandbox:build`, or the Compose `computer` service)
- Docker Engine available to the supervisor (socket mount on the Compose path)

Verify:

```bash
curl -fsS http://127.0.0.1:3100/health
# expect sandbox: docker
```

Signup and local Docker computers work **without** an E2B (or other remote) account.

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

After changing provider or keys, recreate the stack from the checkout:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml up -d --wait --pull never
curl -fsS https://app.example.com/health
```

Confirm `sandbox` equals the intended provider (`e2b`).
A missing API key stops the API at startup. A present but invalid key still reports the selected
provider. Open a bot's computer to verify
provisioning and desktop access.
