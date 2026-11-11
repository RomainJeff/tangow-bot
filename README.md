# Tangow

![tangow](docs/assets/readme-header.png)

Tangow is an open-source platform for running persistent AI teammates. It is available on the web,
as an Electron desktop app, and through an Expo mobile app. Bring your own model and computer
provider, or run the complete stack locally.

## Stack

- TypeScript
- React 19, Vite, and Tailwind CSS
- Electron and Expo
- Hono and oRPC
- PostgreSQL and Prisma
- Better Auth
- Graphile Worker
- Pi
- Docker and E2B
- Composio, Pipedream Connect, MCP, and OpenAPI integrations

For an existing source deployment, use the [`./tangow` operator CLI](./docs/tangow.md) on the server to update it,
inspect services, rebuild workers and computers, or migrate Docker homes to E2B.

## Getting started

You need Git, Docker with Compose, and Node.js 22.22.2 or newer in the 22.x line,
Node.js 24.x, or Node.js 26+. Node.js 23.x and 25.x are not supported.

```bash
git clone https://github.com/RomainJeff/tangow-bot.git
cd tangow-bot
./tangow setup
```

The wizard creates a private `.env`, generates deployment secrets, builds the current checkout,
starts the services, and verifies readiness. Open the URL it prints, create your first owner
account, connect a model, and create a bot. Use `./tangow setup --sudo` if Docker requires
passwordless sudo.

Docker is the default computer provider. Selecting E2B continues through the existing provider
setup after Docker starts; it needs pnpm 9, an existing E2B service, and a registry you can push to.
For a public HTTPS origin, prepare a reverse proxy to `127.0.0.1:5173` and have SMTP credentials
and a signup allowlist ready. Setup does not configure DNS or TLS. See [Tangow setup](./docs/tangow.md#first-deployment)
for prerequisites and retries, and [self-hosting](./docs/self-host.md) for server configuration.

Rerun `./tangow setup` to retry with saved credentials. Use `./tangow update` for future upgrades.

## Development (source checkout)

You need Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x, or Node.js 26+;
pnpm 9; and Docker. Node.js 23.x and 25.x are not supported.

```bash
git clone https://github.com/RomainJeff/tangow-bot.git
cd tangow-bot
cp .env.example .env
```

Set `POSTGRES_PASSWORD` (for example `openssl rand -hex 16`), then put the same value in
`DATABASE_URL`. Set `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to
independent long random values. Docker sandboxes also need a dedicated
`SANDBOX_SUPERVISOR_TOKEN`. You can also set `OPENROUTER_API_KEY`, or connect a supported
model provider during onboarding.

Managed app catalogs are optional. Set `COMPOSIO_API_KEY` for Composio, or the
`PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, and `PIPEDREAM_PROJECT_ID` trio for Pipedream
Connect. Users can add an HTTPS MCP server, Treg endpoint, or OpenAPI JSON document from
**Integrations** without enabling either managed catalog. Connector credentials are encrypted on the
server and are never returned by the API.

Treg is usage-metered. Self-hosters supply their own Treg token; operators embedding Treg in a
hosted product should review [Treg's integration terms](https://treg.to/integrate.md), which require
a written agreement for hosted resale.

```bash
docker compose --env-file .env \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml \
  up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build   # builds the computer and worker images
pnpm dev
```

Postgres stays network-internal in the default Compose file. The
`postgres-host` overlay publishes loopback `127.0.0.1:5433` for host-side `pnpm` and DB tools.
Without the overlay, open a shell with
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
Use a URI-safe `POSTGRES_PASSWORD` (`openssl rand -hex 16`). An existing `pgdata` volume keeps the
user, password, and database from first init, so keep those values in `.env`, or change them in
place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when the data is
disposable); `docker compose down -v` deletes all Postgres state.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), create an account, connect a model, and create
your first bot.

For an agent-assisted install, use the [Tangow operator guide](./docs/tangow.md).

## Run on a server

Bots stay on when the backend runs on a server. Clone the repository on a VPS, build it with the
production Compose file, then connect from the desktop app, the mobile app, or a browser.
[docs/self-host.md](./docs/self-host.md#public-single-vm-deployment) covers the build, the Caddy
setup, host hardening, provider selection, backups, and upgrades. In the desktop app enter the
`https://` address.

## Desktop and mobile

The Electron and Expo apps are clients of the same Tangow API used by the web app.

With the development stack running, launch Electron with:

```bash
pnpm --filter @tangow/desktop dev
```

On first run the desktop app asks for the address of a Tangow server. Developers running
`pnpm dev` enter `http://127.0.0.1:5173`. Public servers must use HTTPS; HTTP is accepted only for
loopback and private LAN addresses (not link-local). The app verifies Tangow's health endpoint
before saving, and later launches go straight to that instance.

Use **Change Tangow Server…** in the application menu to reconnect. Closing that window without
saving returns to the previous instance. For development automation, set `TANGOW_WEB_URL` to point
the shell somewhere else without changing the saved instance, or `TANGOW_FORCE_SETUP=1` to run
setup again.

Mobile build and release instructions live in [docs/mobile-release.md](./docs/mobile-release.md).

## Development

```text
apps/       web, api, worker, desktop, mobile, and public website
packages/   domain, contracts, persistence, adapters, UI, and test tooling
infra/      local services and computer images
docs/       architecture, operations, and release guides
```

Common checks:

```bash
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
```

## Documentation

- [Architecture](./ARCHITECTURE.md)
- [Self-hosting](./docs/self-host.md)
- [Self-host secrets](./docs/self-host-secrets.md)
- [Self-host E2B workers](./docs/self-host-e2b-workers.md)
- [Computer runtime and isolation](./docs/computer-runtime.md)
- [Mobile releases](./docs/mobile-release.md)
- [Rebuilding the mobile and desktop clients](./docs/shipping-clients.md)
- [Performance testing](./docs/performance.md)

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull
request. For security vulnerabilities, follow [SECURITY.md](./SECURITY.md) instead of filing a public
issue.

Tangow is licensed under the [Apache License 2.0](./LICENSE).

Questions and ideas are welcome in the [Tangow Discord community](https://discord.gg/RWwKa2Sn7h).
