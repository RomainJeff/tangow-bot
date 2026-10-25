---
name: tangow
description: Use when operating a Rakazo source server with Tangow, including updates, Docker or E2B computer builds, provider migration, restarts, cleanup, or recovery after an interrupted deployment.
---

# Tangow

Operate the source deployment through Tangow **on the server**. Locate the authorized host and
checkout from session context or private deployment configuration; do not bake real hosts, paths
or credentials into this skill. SSH can reach the server, but Tangow has no `--host` option.

Read [the operator guide](../../../docs/tangow.md) for prerequisites and provider migration details.
Run `./tangow --help` in the target checkout to check the installed commands. This skill is for
source Compose deployments, not the published-image installer or installing E2B infrastructure.

## Establish the state

Start with `./tangow status` and a clean checkout. Check host Node/pnpm against `package.json`
before E2B builds. Tangow reads provider configuration from `.env.e2b.compose.json`; optional
`.env.tangow.json` supplies `sudo` and `computerImage`. Let the CLI read private configuration;
use configured sudo or `--sudo` for root-owned overrides rather than printing their contents.
Never switch provider just by editing `SANDBOX_PROVIDER` in `.env`: source Compose forces Docker
without the E2B override.

If Tangow is absent, first check that its commit is on `origin/main`. Bootstrap only the clean,
fast-forwardable server checkout to that revision using Git as its owner, then run Tangow.
Stop on local changes or divergent commits; do not reset history to make deployment succeed.

## Choose the operation

| Request | Command on the server | Result to verify |
| --- | --- | --- |
| Update Rakazo | `./tangow update` | Target main revision, provider, application images and readiness; Docker images or both E2B templates rebuilt automatically. |
| Restart existing services | `./tangow restart` | Same running revision and images return; this does not deploy newer checkout code. |
| Inspect a failure | `./tangow status`, `./tangow logs worker` or `./tangow logs api` | Failed stage and checkout/runtime mismatch. |
| Rebuild only computers/templates | `./tangow computers build` | On E2B, source must match the running API and worker; use `update` for a new revision. |
| Move Docker homes to E2B | `./tangow provider e2b` | Existing setup completes backups, home migration and provider readiness. |
| Remove unused Docker builds | `./tangow cleanup --yes` | Cache and unused images pruned; containers and volumes retained. |

`--dry-run` describes an operation; it does not prove prerequisites or connectivity. Keep mutations
within the user's request. An update request already covers its builds and restart; do not ask
again for each step. Run cleanup when requested. Use `--migrate-existing` only when the user has
authorized the one-way home move, including any consent already given in this session. Keep
credentials in private configuration or the secret-entry mechanism available in the environment.

## Recover by the failed stage

- If `.env.e2b.upgrade.json` exists, keep API/worker stopped and rerun the same
  `./tangow provider e2b` operation with the same registry/configuration to resume. Read the setup
  guide's recovery section if it refuses. Do not bypass the journal with Compose up/restart,
  delete it, or revert the override to Docker.
- After an application/template build or readiness failure without a migration journal, inspect
  the reported stage, fix the cause and rerun `./tangow update`. Git may already have advanced and
  templates may already be published. `restart` alone keeps existing containers; it cannot finish
  deployment of newer code. Do not claim a template or database rollback.
- For `.env.tangow.lock` or `.env.e2b.setup.lock`, inspect its PID on that server. Remove a stale
  lock only after confirming the owner process has ended; retain an active lock.
- E2B-to-Docker home migration is unsupported. `provider docker` only confirms Docker mode and
  refuses existing E2B volumes. Report this limit rather than deleting the private override.

## Verify computers separately

A successful `update` publishes builds and updates server services; it does not replace existing
computers. For replacement, use **Settings > Computer > Update all computers** within the user's
authorized scope. Busy computers are skipped. Identify affected bots when available and retry
after their work/control lease ends; do not acquire viewer control just to perform maintenance.

If asked whether computers are current, compare each computer's actual provider build/image with
the expected published build using available provider inspection. A completed database operation,
a new template, or server `Ready` alone does not prove the active computer's image. If inspection
is unavailable, report that verification is incomplete instead of claiming every computer updated.

Finish with the verified application revision/provider, image/template result, remaining computers
or affected bots, and any failed stage or retry needed. Distinguish a dry run, a queued operation
and verified completion. Keep secrets and real deployment identifiers out of public PRs and logs.
