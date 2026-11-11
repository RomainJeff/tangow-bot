#!/usr/bin/env bash
# Rebuild the clients a change actually needs.
#
# Mobile: publishes an EAS Update when the change only touches mobile JS/TS/CSS,
# otherwise runs a native EAS build. The eligible paths mirror the OTA gate in
# .github/workflows/ci.yml, so a change CI would refuse to publish over an older
# native runtime is not published here either.
# Desktop: repacks only when the packaged app's own code or bundled renderer changed.
#
# Usage: pnpm ship [--native] [--dir] [--mobile-only|--desktop-only]
#   --native  force a native mobile build even if an update would do
#   --dir     pack the desktop app unsigned for the host platform only (fast local check)
set -euo pipefail
cd "$(dirname "$0")/.."

CHANNEL="${SHIP_CHANNEL:-preview}"
MARKER_DIR=".ship"
force_native=false
desktop_dir=false
do_mobile=true
do_desktop=true

for arg in "$@"; do
  case "$arg" in
    --native) force_native=true ;;
    --dir) desktop_dir=true ;;
    --mobile-only) do_desktop=false ;;
    --desktop-only) do_mobile=false ;;
    *) echo "ship: unknown flag $arg" >&2; exit 2 ;;
  esac
done

# Files changed since the sha recorded for $1, including uncommitted and untracked work.
# No marker (first run, or a fresh clone) prints nothing and the caller treats that as "rebuild".
changed_since() {
  local marker="$MARKER_DIR/$1" base
  [[ -f "$marker" ]] || return 1
  base="$(cat "$marker")"
  git cat-file -e "$base^{commit}" 2>/dev/null || return 1
  git diff --name-only "$base"
  git ls-files --others --exclude-standard
}

record() {
  mkdir -p "$MARKER_DIR"
  git rev-parse HEAD > "$MARKER_DIR/$1"
}

# Reads changed paths on stdin. True when every mobile-relevant change is
# OTA-eligible and at least one exists. Kept stdin-driven so ship.test.sh can
# exercise it without a git history.
mobile_ota_eligible() {
  local eligible=false file
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    case "$file" in
      *.test.ts|*.test.tsx|*.d.ts) continue ;;
      apps/mobile/app/*.ts|apps/mobile/app/*.tsx|\
      apps/mobile/components/*.ts|apps/mobile/components/*.tsx|\
      apps/mobile/lib/*.ts|apps/mobile/lib/*.tsx|\
      packages/chat-ui/src/*.ts|packages/chat-ui/src/*.tsx|packages/chat-ui/src/*.css|\
      packages/contracts/src/*.ts|packages/core/src/*.ts) eligible=true ;;
      apps/mobile/*|packages/chat-ui/*|packages/contracts/*|packages/core/*|package.json|pnpm-lock.yaml)
        return 1 ;;  # native-sensitive: config, deps, modules, assets
    esac
  done
  [[ "$eligible" == true ]]
}

# Reads changed paths on stdin.
desktop_changed() {
  local file
  while IFS= read -r file; do
    case "$file" in
      apps/desktop/*|apps/web/*|packages/chat-ui/*|packages/contracts/*|packages/core/*|pnpm-lock.yaml)
        return 0 ;;
    esac
  done
  return 1
}

mobile_native() {
  echo "==> mobile: native build (profile '$CHANNEL')"
  pnpm --filter @tangow/mobile check
  (cd apps/mobile && npx eas-cli@latest build --platform ios --profile "$CHANNEL" --non-interactive)
  record mobile-native
}

mobile() {
  local files
  if [[ "$force_native" == true ]]; then mobile_native; return; fi
  if ! files="$(changed_since mobile-native)"; then
    echo "==> mobile: no native build recorded yet"
    mobile_native
    return
  fi
  if [[ -z "${files//[[:space:]]/}" ]]; then
    echo "==> mobile: nothing changed since the last native build, skipping"
    return
  fi
  if ! mobile_ota_eligible <<< "$files"; then
    mobile_native
    return
  fi
  echo "==> mobile: JS-only change, publishing an update to '$CHANNEL'"
  pnpm --filter @tangow/mobile check
  (cd apps/mobile && npx eas-cli@latest update --platform all --channel "$CHANNEL" \
    --environment "$CHANNEL" --message "$(git log -1 --pretty=%s)" --non-interactive)
}

desktop() {
  local files
  if ! files="$(changed_since desktop)" || desktop_changed <<< "$files"; then
    echo "==> desktop: packing"
    if [[ "$desktop_dir" == true ]]; then
      pnpm --filter @tangow/desktop pack:dir
    else
      pnpm --filter @tangow/desktop pack
    fi
    record desktop
  else
    echo "==> desktop: nothing changed since the last pack, skipping"
  fi
}

# ponytail: sourced by scripts/ship.test.sh, which only wants the classifiers.
if [[ "${SHIP_LIB_ONLY:-}" == 1 ]]; then return 0; fi

# Mobile waits on EAS' remote queue; desktop burns local CPU. Run both at once.
status=0
if [[ "$do_mobile" == true && "$do_desktop" == true ]]; then
  mobile & mobile_pid=$!
  desktop || status=1
  wait "$mobile_pid" || status=1
elif [[ "$do_mobile" == true ]]; then
  mobile || status=1
else
  desktop || status=1
fi
exit "$status"
