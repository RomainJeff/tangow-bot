#!/usr/bin/env bash
set -euo pipefail

: "${T05_COMPUTER_IMAGE:?Set T05_COMPUTER_IMAGE to the Computer image to probe}"

# Run from the worktree root with Node 22 and the offline dependencies installed.
node --version
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
export TMPDIR
TMPDIR="$(mktemp -d /tmp/rakazo-j3d2f-XXXXXX)"
export BUILDX_CONFIG="$TMPDIR/buildx"
mkdir "$BUILDX_CONFIG" "$TMPDIR/evidence"
network="rakazo-j3d2f-${TMPDIR##*-}"
container="$network-probe"
image="$T05_COMPUTER_IMAGE"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

pnpm exec tsx packages/testkit/src/cli/t05-claude-mcp-capture.ts "$TMPDIR/invocation.json"
relay_alias="$(node -p 'new URL(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).relayUrl).hostname' "$TMPDIR/invocation.json")"
docker image inspect "$image" --format 'IMAGE_ID={{.Id}}'
docker network create --internal "$network" >/dev/null
docker network inspect "$network" --format 'NETWORK_INTERNAL={{.Internal}}'
set +e
docker run --name "$container" --pull never --read-only --user rakazo \
  --network "$network" --network-alias "$relay_alias" \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --mount "type=bind,src=$TMPDIR/evidence,dst=/evidence" \
  --mount "type=bind,src=$(command -v node),dst=/probe-bin/node,readonly" \
  --mount "type=bind,src=$TMPDIR/invocation.json,dst=/probe/invocation.json,readonly" \
  --mount "type=bind,src=$PWD/packages/testkit/src/cli/t05-claude-mcp-probe.mjs,dst=/probe/t05-claude-mcp-probe.mjs,readonly" \
  --mount "type=bind,src=$PWD/packages/testkit/src/cli/t05-fake-mcp-relay.mjs,dst=/probe/t05-fake-mcp-relay.mjs,readonly" \
  --entrypoint /usr/bin/env "$image" -i PATH=/probe-bin:/usr/local/bin:/usr/bin:/bin \
  /bin/bash -c 'set -e; node --version; exec node /probe/t05-claude-mcp-probe.mjs --run'
result=$?
set -e
# Recovery read precedes removal, even if the report itself failed. Comparisons only.
if test -f "$TMPDIR/evidence/requests.jsonl"; then
  cp "$TMPDIR/evidence/requests.jsonl" .j3d2f-relay.log
  node --version
  node --input-type=module - "$TMPDIR/evidence/requests.jsonl" <<'NODE'
import { readFile } from 'node:fs/promises';
import { relayReport } from './packages/testkit/src/cli/t05-claude-mcp-probe.mjs';
console.log('HOST_RECORD_READ_BEFORE_CLEANUP=yes');
for (const line of relayReport(await readFile(process.argv[2], 'utf8'))) console.log(line);
NODE
fi
echo "PROBE_EXIT=$result"
docker rm "$container" >/dev/null
docker network rm "$network" >/dev/null
echo "PROBE_CONTAINER_REMOVED=yes"
echo "PROBE_NETWORK_REMOVED=yes"
exit "$result"
