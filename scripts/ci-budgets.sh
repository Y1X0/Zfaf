#!/usr/bin/env bash
#
# Performance budgets as a required check (D10.3).
#
# The measurement needs a running server, because two of the three surfaces are
# measured from the **document they actually serve** rather than from the build
# manifest — the manifest overstates the marketing surface and says nothing
# useful about `/i/[slug]` at all (ADR-0020 §, ADR-0021 §3). So this stands the
# standalone server up, seeds one published invitation, measures, and stops.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BUDGET_PORT:-3200}"
BASE="https://127.0.0.1:${PORT}"

# The same complete, non-secret environment `playwright.config.ts` gives the
# server. `packages/config` refuses to run on a partial environment — which is
# the behaviour we want in production and therefore the behaviour this has to
# satisfy honestly rather than relax. Nothing here is a secret; the storage
# endpoint points nowhere and is never reached.
export NODE_ENV=production
export PUBLIC_BASE_URL="$BASE"
export DATABASE_URL="${DATABASE_URL:-postgresql://zfaf:zfaf_local_dev@127.0.0.1:5432/zfaf?schema=public}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export SESSION_SECRET="${SESSION_SECRET:-ci-session-secret-value-at-least-32-characters-long}"
export TOTP_ENCRYPTION_KEY="${TOTP_ENCRYPTION_KEY:-ci-totp-encryption-key-at-least-32-characters-long}"
export STORAGE_DRIVER=s3
export STORAGE_ENDPOINT=http://127.0.0.1:9000
export STORAGE_REGION=auto
export STORAGE_BUCKET_MEDIA=zfaf-media
export STORAGE_ACCESS_KEY_ID=ci
export STORAGE_SECRET_ACCESS_KEY=ci-secret
export STORAGE_PUBLIC_BASE_URL=http://127.0.0.1:9000/zfaf-media
# The real adapter, pointed at the sink `start-standalone.mjs` serves on
# PORT + 2. Not `noop`: the configuration layer refuses it under
# NODE_ENV=production, because a transport that silently sends nothing is the
# fault that rule exists to prevent. Nothing below is a credential.
export MAIL_DRIVER=resend
export MAIL_RESEND_API_KEY=ci-not-a-real-key
export MAIL_RESEND_ENDPOINT="http://127.0.0.1:$((PORT + 2))/emails"
export MAIL_FROM_ADDRESS=no-reply@zfaf.test
export DEFAULT_MARKET=SA

cleanup() {
  local status=$?
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

echo "Seeding one published invitation to measure…"
SLUG="$(cd "$ROOT/apps/web" && npx tsx e2e/fixtures/seed-one.ts)"
echo "  slug: $SLUG"

echo "Starting the standalone server on ${PORT}…"
(cd "$ROOT/apps/web" && PORT="$PORT" node scripts/start-standalone.mjs >/tmp/budget-server.log 2>&1) &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -sk "${BASE}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sk "${BASE}/api/health" >/dev/null || { echo "server did not start"; cat /tmp/budget-server.log; exit 1; }

NODE_TLS_REJECT_UNAUTHORIZED=0 \
MEASURE_BASE_URL="$BASE" \
MEASURE_SLUG="$SLUG" \
  node "$ROOT/scripts/measure-bundles.mjs" "$ROOT/apps/web"
