#!/usr/bin/env bash
# Guards the ship.sh rebuild classifiers. Run: bash scripts/ship.test.sh
set -euo pipefail
SHIP_LIB_ONLY=1 source "$(dirname "$0")/ship.sh"

fail=0
ota() { # ota <expected yes|no> <path...>
  local want="$1"; shift
  local got=no
  printf '%s\n' "$@" | mobile_ota_eligible && got=yes
  [[ "$got" == "$want" ]] || { echo "FAIL ota: want $want got $got for: $*" >&2; fail=1; }
}
pack() {
  local want="$1"; shift
  local got=no
  printf '%s\n' "$@" | desktop_changed && got=yes
  [[ "$got" == "$want" ]] || { echo "FAIL pack: want $want got $got for: $*" >&2; fail=1; }
}

ota yes apps/mobile/app/index.tsx
ota yes "apps/mobile/app/(tabs)/chat.tsx" apps/mobile/lib/api.ts
ota yes packages/chat-ui/src/theme.css packages/core/src/ids.ts
ota no apps/mobile/app.config.ts                      # native config
ota no apps/mobile/package.json                       # native deps
ota no apps/mobile/modules/foo/ios/Foo.swift          # native module
ota no apps/mobile/assets/icon.png                    # bundled asset
ota no pnpm-lock.yaml
ota no apps/mobile/app/index.tsx apps/mobile/eas.json # one blocker blocks all
ota no apps/api/src/server.ts                         # nothing mobile changed
ota no apps/mobile/lib/api.test.ts                    # tests alone ship nothing

pack yes apps/desktop/src/main.ts
pack yes apps/web/src/App.tsx
pack yes packages/contracts/src/schema.ts
pack no apps/api/src/server.ts
pack no apps/mobile/app/index.tsx
pack no docs/mobile-release.md

[[ "$fail" == 0 ]] && echo "ship classifiers ok"
exit "$fail"
