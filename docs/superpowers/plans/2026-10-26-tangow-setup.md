# Tangow setup implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. Steps use checkbox syntax for tracking.

**Goal:** Deploy the current source checkout through an interactive setup command, then document it as the getting started path.

**Architecture:** Collect and save configuration under the existing deployment lock. Share the build/start/verify branch with update, keeping Git synchronization exclusive to update. Continue into the existing E2B setup script when selected.

**Tech stack:** Node standard library, Docker Compose, existing Tangow scripts and offline Node tests.

**Spec:** `docs/superpowers/specs/2026-10-25-tangow-setup-design.md`, approved in conversation.

## Global constraints

- Deploy HEAD without fetching or switching branches.
- Do not rotate saved database or encryption credentials.
- Keep private files owner-only and secret inputs hidden; no credentials in child command arguments or logs.
- Keep provider-migration guards and the deployment lock ahead of writes.
- Use existing Docker/E2B orchestration and deterministic offline tests; do not deploy on the maintainer's machine.
- Update the README getting started, operator/self-host guides and changelog.

## Review focus

- Existing volumes with missing credentials must stop setup before writing or starting services.
- Literal dollar signs, quotes and hashes in supplied values must survive Compose interpolation.
- Cancellation must release the lock and preserve previous configuration.
- Public origin setup must configure hostname access and signup/email policy before startup.
- A failed optional E2B continuation must retain configuration and use existing recovery instructions.

## Task 1: Setup through verified deployment

**Files:** Add `scripts/tangow-setup.mjs`, `scripts/tangow-signup-policy.mjs` and a PostgreSQL integration test in testkit; modify `scripts/tangow.mjs`, `scripts/tangow-options.mjs`, `scripts/tangow.test.mjs`, `README.md`, `docs/tangow.md`, `docs/self-host.md` and `CHANGELOG.md`.

**Interfaces:** `configureSetup({root, values, provider, run, dock, git, writePrivate})` returns the selected provider, origin and whether this is a new deployment. Reuse the existing `run`, `dock`, `comp`, `buildComputers` and verification functions. The production CLI remains the test entrypoint.

- [x] Extend the existing CLI fixture with input and fresh-deployment state; add tests proving setup deploys HEAD, writes private usable configuration, preserves saved settings on retry, rejects missing credentials with existing state and releases locks on cancellation. Extend dry-run coverage. Run `pnpm test:tangow` and observe setup tests fail because the command is unknown.
- [x] Implement terminal input and configuration collection using the Node standard library. Validate origin, SMTP/public signup policy and required saved credentials; use atomic private writes. Detect existing Compose containers/volumes before generating secrets. Prompt for optional E2B only when needed.
- [x] Register setup and route it under migration guards and the existing lock before the `.env` prerequisite. Share update's build/start/check flow, using HEAD for setup. Run the existing provider setup script for E2B continuation and verify the final provider. Keep dry-run side-effect free.
- [x] Update the README quick start to clone and run `./tangow setup`; retain development instructions separately. Document prerequisites, public TLS scope, generated configuration, retries, optional E2B and model onboarding. Add one changelog capability entry dated 2026-10-26.
- [x] Run Tangow and E2B setup tests, focused formatting/lint, affected E2E selection and diff checks. Audit tests for meaningful behavior and inspect public content for private data. Capture CLI help/dry-run evidence; no product-screen screenshots because no client UI changes.
- [ ] Obtain one independent whole-diff review, fix material issues, rerun affected checks, commit and open a PR to main. Link the PR to this thread and monitor checks/review with T3.

## Review and rulings

The founding-engineer review of the complete design applies unchanged to this implementation plan. Its accepted lock, hostname and deployed-state recommendations are included above. Optional E2B continuation remains a direct reuse of the existing provider script, as recorded in the design.

The user authorized implementation and PR creation. Execute inline without another approval handoff. Roughdraft was unavailable during design review; approval was given in conversation.

Whole-diff review found three material defects, all accepted: explicitly pull Postgres/data-init images for fresh machines; apply the collected public signup policy to persisted deployment settings before starting services; replace synchronous question reads with asynchronous input so Ctrl+C cancels immediately. These correct the existing first-deployment and retry requirements. The policy script reuses the shared signup parser, preserves unrelated settings and runs inside the application container. A focused PostgreSQL test is registered in the existing integration harness.
