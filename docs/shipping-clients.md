# Rebuilding the mobile and desktop clients

`pnpm ship` replaces the manual pair of commands:

```sh
# before
cd apps/mobile  && npx eas-cli@latest build --platform ios --profile preview
cd apps/desktop && npm run pack
```

```sh
# now, from the repository root
pnpm ship
```

It does three things the manual pair did not:

- **Publishes an update instead of a native build** when the change only touches
  mobile JavaScript, TypeScript, or bundled CSS. An `eas update` lands on an
  installed preview build in about a minute; a native EAS build takes tens of
  minutes and a new install.
- **Skips the desktop pack** when nothing the packaged app ships has changed.
- **Runs both clients at once.** The mobile step waits on EAS' remote queue
  while the desktop pack uses local CPU, so serialising them wastes wall clock.

## What it decides, and how

State lives in `.ship/` (gitignored): one file per target holding the commit sha
of the last build. "Changed" means `git diff` against that sha plus untracked
files, so uncommitted work counts.

| Change | Mobile | Desktop |
|---|---|---|
| `apps/mobile/{app,components,lib}/**.{ts,tsx}` | update | skip |
| `packages/{chat-ui,contracts,core}/src/**.{ts,tsx,css}` | update | pack |
| `apps/mobile/app.config.ts`, `eas.json`, `app.json` | native build | skip |
| `apps/mobile/package.json`, `pnpm-lock.yaml`, `modules/**`, `assets/**` | native build | pack |
| `apps/desktop/**`, `apps/web/**` | skip | pack |
| `apps/api/**`, `apps/worker/**`, docs | skip | skip |
| nothing since the last build | skip | skip |

Any single native-sensitive file forces a native build even if the rest of the
change is pure JS: an OTA bundle that expects a native module the installed
runtime does not have will crash on launch. This mirrors the OTA gate in
`.github/workflows/ci.yml`, so a change CI refuses to publish is not published
from a laptop either. `pnpm ship:test` covers the classification table above.

## Flags

| Flag | Effect |
|---|---|
| `--native` | Force a native mobile build, ignoring the change set. Use after changing anything on EAS' side — credentials, environment variables, build profile. |
| `--dir` | Pack the desktop app unpacked for the host platform only (`pack:dir`). Much faster than the signed mac + win + linux `pack`; not distributable. |
| `--mobile-only` / `--desktop-only` | Run one target. |

`SHIP_CHANNEL` selects the EAS profile, channel, and environment. It defaults to
`preview`; set `SHIP_CHANNEL=production` for a store-bound build. Production
releases still go through CI and the checklist in
[docs/mobile-release.md](./mobile-release.md) — `pnpm ship` is a local
convenience, not a release process.

## When it is the wrong tool

- **Iterating on the desktop app.** `pnpm --filter @rakazo/desktop dev` builds
  and launches Electron directly. No pack needed.
- **Iterating on the mobile app.** `pnpm --filter @rakazo/mobile start` with
  Expo Go or a dev build reloads on save. No EAS round trip needed.
- **First build after a fresh clone.** `.ship/` is empty, so both targets build
  from scratch. That is correct, just slow.

`pnpm ship` is for handing a colleague something installable.
