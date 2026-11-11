# Mobile builds and store releases

Tangow's public repository contains no signing credentials, API keys, Apple
team, or Google Play identifiers. The only store identifier tracked here is the
iOS App Store Connect app ID in `apps/mobile/eas.json`, which submissions need
and which Apple already exposes publicly. Every other value belongs in the
release operator's private configuration.

Self-hosters normally do not need to publish their own mobile app: the Tangow
client can select a compatible server from the sign-in screen. If you distribute
your own branded build, use your own Expo and store accounts.

## Configure a build

1. Link `apps/mobile` to an Expo project owned by your account.
2. Choose unique iOS and Android application identifiers.
3. Configure `EXPO_PUBLIC_API_URL` in the EAS build environment. Production
   builds require a valid HTTPS URL. To bake a Cloudflare Access service token
   into an internally distributed build, also set
   `EXPO_PUBLIC_CF_ACCESS_CLIENT_ID` and `EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET`
   together. These are inlined into the bundle and readable by anyone who
   unpacks the app, so never set them for a public store release. See
   [Cloudflare Access](./self-host.md#cloudflare-access).
4. Keep team IDs, signing credentials, API keys, and review-account
   credentials out of Git. Set the iOS App Store Connect app ID under
   `submit.production.ios.ascAppId` in `eas.json` so `eas submit` runs
   non-interactively.
5. Before a native iOS or Android build, run
   `pnpm --filter @tangow/mobile exec expo install --check`. Attachment pickers
   and other Expo native modules must match the SDK (SDK 57 needs
   `expo-image-picker@~57.0.11`, not 17.x). Use `pnpm exec expo install --fix`
   from `apps/mobile` if that check fails.

From `apps/mobile`:

```sh
eas project:init
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://app.example.com --visibility plaintext
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

From the repository root, `pnpm submit:ios` runs that same submission.

### Local iOS builds

These shortcuts build on your Mac with `eas build --local` (Xcode and
CocoaPods required) and write the IPA to `apps/mobile/builds/`, which Git
ignores. Run them from the repository root or from `apps/mobile`.

| Command | Profile | Result |
| --- | --- | --- |
| `pnpm build:ios:preview` | `preview` (internal, Ad Hoc) | `builds/tangow-preview.ipa`, install it with Expo Orbit or `xcrun devicectl` |
| `pnpm release:ios` | `production` (App Store) | builds `builds/tangow-production.ipa`, then submits that exact file to TestFlight |

A production IPA is signed with an App Store profile and cannot be installed
directly on a device; iOS reports "Failed to verify code signature" or
"Failed to install embedded profile". Use TestFlight for it, or a preview build
for direct installs.

A preview build only installs on devices listed in its Ad Hoc profile. Register
each device once before building, then let EAS regenerate the profile when it
asks:

```sh
npx eas-cli@latest device:create
```

The production profile uses `autoIncrement`; check that each local build gets a
new build number, since TestFlight rejects a reused one.

EAS can prompt for store identity interactively. For automated submission, add
the required identifiers through a private CI configuration or a short-lived
local change that is never committed.

Before submission, verify the production API, account deletion, sign-in,
notifications, store privacy answers, age rating, screenshots, support page,
and review account on a physical device.

## Over-the-air updates

Production and preview builds include `expo-updates` and use the corresponding
EAS Update channel. The runtime version follows the public app version, so bump
`expo.version` whenever native code, config plugins, permissions, or native
dependencies change, then create and submit new store builds.

After the full GitHub Actions test suite passes on `main`, CI publishes a
production OTA update when the revision only changes the mobile JavaScript,
TypeScript, or bundled CSS. CI deliberately skips OTA publishing when native
configuration, modules, dependencies, assets, or the update workflow changed.
The repository needs an `EXPO_TOKEN` Actions secret with access to the linked
Expo project.

For day-to-day preview rebuilds, `pnpm ship` from the repository root picks the
update-or-native-build decision for you and packs the desktop app in parallel.
See [docs/shipping-clients.md](./shipping-clients.md).

To publish a compatible update manually from `apps/mobile`:

```sh
eas update --platform all --channel production --environment production --message "Short description"
```

Installed release builds download a compatible update in the background on
launch and apply it after the next restart. Builds created before
`expo-updates` was configured cannot receive OTA updates and must be replaced
with a new iOS and Android build once.
