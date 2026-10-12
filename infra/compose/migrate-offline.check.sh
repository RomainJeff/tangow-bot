#!/usr/bin/env bash
# Proves the migrate service needs no egress: the app image migrates a fresh Postgres over an
# internal network, the only network the migrate service has in the compose files. Needs Docker
# and a built app image, so it stays out of run-smokes.sh.
#
#   infra/compose/migrate-offline.check.sh <app image>
set -euo pipefail
image=${1:?usage: migrate-offline.check.sh <app image>}
name="rakazo-migrate-offline-$$"
cleanup() {
  docker rm -f "$name-db" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create --internal "$name" >/dev/null
docker run -d --name "$name-db" --network "$name" -e POSTGRES_USER=rakazo \
  -e POSTGRES_PASSWORD=offline-check -e POSTGRES_DB=rakazo "${POSTGRES_IMAGE:-postgres:16}" >/dev/null
for _ in $(seq 60); do
  docker exec "$name-db" psql -U rakazo -d rakazo -c 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
sleep 2

docker run --rm --network "$name" \
  -e DATABASE_URL="postgres://rakazo:offline-check@$name-db:5432/rakazo" \
  "$image" pnpm exec tsx scripts/backfill-session-log.ts
docker exec "$name-db" psql -U rakazo -d rakazo -tAc \
  "SELECT count(*) > 0 AND to_regclass('public.messages') IS NULL FROM _prisma_migrations" | grep -qx t
echo "The migrate service ran with no egress."
