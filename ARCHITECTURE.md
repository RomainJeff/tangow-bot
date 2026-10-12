# Architecture

Rakazo is one product on the web, the Electron desktop app and the Expo mobile app, and Electron hosts the web app. Shared contracts, logic and UI live in `packages/`. The frontends express intent and render state, and the backend, the API and the worker, owns orchestration, authorization, validation, retries and provider translation. No hosted vendor is required to run the core product, since models, sandboxes, memory and integrations sit behind optional provider-neutral ports. [AGENTS.md](./AGENTS.md) holds these rules.

## Session log

A conversation is an append-only log of typed entries in Postgres, keyed by session. The model's context and the thread a person sees are two projections of the same entries, in [`packages/core/src/session-log/`](./packages/core/src/session-log/). Which types exist and who reads each is `ENTRY_AUDIENCE` in [`session-log.ts`](./packages/contracts/src/session-log.ts).
Read more in [Session log architecture](./docs/architecture-sessionlog.md).

## Computer runtime

A bot works on a computer kept apart from the agent runtime, which runs in the API and worker process and reaches the computer through its tools. `SandboxProvider` in [`interfaces.ts`](./packages/adapter-kit/src/interfaces.ts) is the provider boundary, with Docker, E2B, Daytona and Box backends in [`packages/adapters/src/`](./packages/adapters/src/).
Read more in [Computer runtime](./docs/computer-runtime.md).

## Reusable credentials

A bot asks for an API key through a protected card. The backend encrypts it in the `bot_secrets` table and injects it into the requests the bot makes, so the model never reads the value. The store and the request path live in [`bot-secrets.ts`](./packages/adapters/src/bot-secrets.ts).
Read more in [Reusable API credentials](./docs/bot-secrets.md).

## UI system

A screen composes semantic tokens and primitives and never defines a color, a size or a duration by hand. The tokens come from one source, [`packages/ui-tokens/src/index.ts`](./packages/ui-tokens/src/index.ts), the web primitives live in [`packages/ui-web`](./packages/ui-web/), and mobile reads the same tokens through [`appearance.ts`](./apps/mobile/lib/appearance.ts).
Read more in [Design system](./docs/design-system.md).
