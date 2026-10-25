# Tangow setup

## Intent

`./tangow setup` guides a self-hoster from a source checkout to a running deployment. It creates private configuration, builds the current checkout, starts services and verifies readiness. The README getting started uses this command. Development instructions remain available separately.

## Decisions

- Deploy the current checkout. Never fetch, switch branches or merge during setup. `update` retains its existing upgrade behavior.
- Run on the deployment machine with Git, supported Node and Docker Compose installed. The wizard checks prerequisites and Docker access, including `--sudo`, before writing configuration. It does not install host tools.
- Ask for the web origin, defaulting to loopback. Derive auth and API URLs and `RAKAZO_HOST` from it. A public origin needs HTTPS and an existing TLS reverse proxy; setup does not configure DNS or certificates. Ask for SMTP and the signup allowlist before first public startup, following the self-hosting guide. Apply the collected signup policy to the database before public startup, including retries, and disclose its effect on existing accounts.
- Generate independent database, auth, encryption, supervisor and screen-proxy secrets locally. Never display them. Secret input, including SMTP credentials, is hidden. Save `.env` with owner-only permissions using atomic replacement and Compose-safe escaping.
- Preserve existing configuration and comments. Keep existing database credentials and cryptographic keys, never rotate them on retries. A copied `.env.example` is not evidence of an existing deployment. Inspect this Compose project's containers and persistent volumes before generating missing or placeholder identity secrets; refuse replacement if deployment state already exists. Keep optional integrations and models out of the mandatory questions. Users connect models in onboarding.
- Start with the source Compose Docker deployment. Offer E2B as an optional continuation through the existing `provider e2b` flow after Docker startup, reusing its hidden credential prompts, templates and readiness checks. Explain this bootstrap before selecting E2B. Ask for its pushable computer-image reference only when selected. Existing E2B configurations remain E2B on retries. Setup does not create E2B infrastructure or log in to a registry.
- Reuse Tangow's deployment lock, provider-migration guards, application and computer builds, migrations and revision/image/readiness verification. Acquire the existing lock and enforce migration guards before collecting or writing configuration. Move the `.env` prerequisite as needed for fresh setup. Extract only the shared deploy step needed by `setup` and `update`; do not duplicate deployment orchestration or introduce a workflow framework.
- On failure retain configuration and data, identify the failed stage, and allow a retry from the same checkout. Do not prune data, rotate credentials or roll back. An interrupted provider migration continues through its existing recovery command.
- End with the web URL and the next action to create the first owner account and connect a model. Verify internal API, worker/container state, provider, built revision/images and web readiness. For remote origins check HTTP access from the host, but do not claim TLS/DNS reachability from an external client or a successful real bot run without performing it.
- `setup --dry-run` describes the flow without prompting, writing files or executing external commands.

## Approaches considered

The user selected deploying the current checkout rather than fetching the latest `main`. A configuration-only wizard was rejected because they want startup and verification included. Reusing existing deployment and provider commands avoids a second deployment implementation. E2B currently requires an already deployed API and worker, so the first E2B install follows the existing Docker bootstrap rather than redesigning provider migration.

## Implementation and verification

Add setup configuration and terminal prompts in `scripts/tangow-setup.mjs`; register the command in `scripts/tangow-options.mjs` and invoke it before the existing `.env` prerequisite. Share the build/start/verify path in `scripts/tangow.mjs`, keeping Git updates exclusive to `update`. Reuse the existing E2B script for optional continuation.

Extend deterministic offline Tangow tests with fake executables and scripted input. Prove that a fresh setup creates usable Compose configuration, preserves secrets and unknown settings on retry, deploys HEAD without Git network/history mutations, checks readiness, and fails safely on cancellation, missing prerequisites and incomplete saved credentials. Verify dry-run and secret redaction. Audit test value with the test-audit skill. Run the affected web E2E selector if required by the eventual changed-file set; do not start a real deployment on the maintainer's machine.

Update `README.md`, `docs/tangow.md`, the self-hosting entrypoint and `CHANGELOG.md` for the new user-visible command. No web, desktop or mobile UI changes are planned.

## Independent review

The founding-engineer review found the scope proportionate, with these recommendations:

- Accepted: acquire the existing deployment lock before any setup writes, to prevent configuration changes during an active update.
- Accepted: derive `RAKAZO_HOST` as well as application URLs, since the web service uses it for hostname access.
- Accepted: distinguish a copied example from deployed state using containers and persistent volumes, not just `.env` existence.
- Rejected: replace optional E2B continuation with a printed command. The wizard is intended to carry users through deployment for their selected provider. Retain a direct call to the existing provider flow, with no duplicate prompts or migration logic.
