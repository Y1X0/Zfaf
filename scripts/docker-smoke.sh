#!/usr/bin/env bash
#
# Builds the production images and proves the application works inside them.
#
# This is step 1 of docs/22 §4, made repeatable. It exists because the first
# time these images were built they revealed four faults that every unit,
# integration and end-to-end test had passed over — a native module that could
# not be resolved from the standalone tree, a CommonJS package that cannot be
# imported by name under a real ESM loader, and two BullMQ names containing a
# character it refuses. None of them were reachable without starting the actual
# containers.
#
# Run it on a machine with unrestricted network access. The `apt` layer needs
# Debian's repositories, and a proxy that blocks them is the one thing that
# stopped this from being run as written (docs/22 §11).
#
#   bash scripts/docker-smoke.sh
#
# It creates nothing outside Docker: no Render service, no cloud resource, no
# secret. Every value it sets is visibly fake, and the database it writes to
# must be local — see the guard below.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WEB_PORT="${SMOKE_WEB_PORT:-10080}"
PROXY_PORT="${SMOKE_PROXY_PORT:-10081}"
MAIL_PORT="${SMOKE_MAIL_PORT:-10082}"
WEB_IMAGE="zfaf-web:smoke"
WORKER_IMAGE="zfaf-worker:smoke"
WEB_NAME="zfaf-web-smoke"
WORKER_NAME="zfaf-worker-smoke"

DATABASE_URL="${DATABASE_URL:-postgresql://zfaf:zfaf_local_dev@127.0.0.1:5432/zfaf?schema=public}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

# This script registers users, seeds an invitation and runs a worker that
# sweeps and expires rows. Pointing it at anything but a local, disposable
# database would not be a test.
if ! printf '%s' "$DATABASE_URL" | grep -qE '@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]'; then
  echo "✖ DATABASE_URL does not look local. This script writes to it; refusing." >&2
  exit 1
fi

failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; failures=$((failures + 1)); }

cleanup() {
  local status=$?
  docker rm -f "$WEB_NAME" "$WORKER_NAME" >/dev/null 2>&1 || true
  [ -n "${MAIL_PID:-}" ] && kill "$MAIL_PID" 2>/dev/null || true
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

# ── Build ──────────────────────────────────────────────────────────────────
# The committed Dockerfiles, unmodified. A substitution here would defeat the
# purpose of the exercise.
if [ "${SMOKE_SKIP_BUILD:-0}" != "1" ]; then
  echo "Building the images…"
  docker build -q -f infra/docker/web.Dockerfile -t "$WEB_IMAGE" . >/dev/null
  docker build -q -f infra/docker/worker.Dockerfile -t "$WORKER_IMAGE" . >/dev/null
fi

# ── Supporting processes ───────────────────────────────────────────────────
# A mail sink, so the Resend adapter has somewhere to post. `noop` is not an
# option: production refuses it, and a transport that sends nothing is the
# fault that rule exists to prevent.
MAIL_LOG="$(mktemp)"
node -e "
  const {createServer} = require('node:http');
  let count = 0;
  createServer((q, s) => {
    q.resume();
    q.on('end', () => {
      count += 1;
      require('node:fs').writeFileSync(process.argv[1], String(count));
      s.writeHead(200, {'content-type': 'application/json'});
      s.end(JSON.stringify({id: 'smoke'}));
    });
  }).listen(Number(process.argv[2]), '127.0.0.1');
" "$MAIL_LOG" "$MAIL_PORT" &
MAIL_PID=$!

# A proxy shaped like a platform load balancer: it forwards the host the client
# asked for. The local end-to-end harness rewrites that header because it can;
# a platform cannot, and the difference is the whole of D9.1 (docs/22 §6).
node -e "
  const {createServer, request} = require('node:http');
  const [listen, upstream] = process.argv.slice(1).map(Number);
  createServer((incoming, outgoing) => {
    const proxied = request(
      {host: '127.0.0.1', port: upstream, path: incoming.url, method: incoming.method,
       headers: {...incoming.headers, 'x-forwarded-proto': 'https'}},
      (response) => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); },
    );
    proxied.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(proxied);
  }).listen(listen, '127.0.0.1');
" "$PROXY_PORT" "$WEB_PORT" &
PROXY_PID=$!

# ── The containers ─────────────────────────────────────────────────────────
# Nothing below is a credential. The storage endpoint resolves nowhere, and the
# mail key reaches the local sink.
container_env=(
  -e "PUBLIC_BASE_URL=https://zfaf.app"
  -e "DATABASE_URL=$DATABASE_URL"
  -e "REDIS_URL=$REDIS_URL"
  -e "SESSION_SECRET=docker-smoke-session-secret-at-least-32-chars"
  -e "TOTP_ENCRYPTION_KEY=docker-smoke-totp-key-a-different-32-chars"
  -e "STORAGE_DRIVER=r2"
  -e "STORAGE_ENDPOINT=https://example.invalid"
  -e "STORAGE_REGION=auto"
  -e "STORAGE_BUCKET_MEDIA=zfaf-media"
  -e "STORAGE_ACCESS_KEY_ID=smoke"
  -e "STORAGE_SECRET_ACCESS_KEY=smoke"
  -e "STORAGE_PUBLIC_BASE_URL=https://cdn.example.invalid"
  -e "MAIL_DRIVER=resend"
  -e "MAIL_RESEND_API_KEY=not-a-real-key"
  -e "MAIL_RESEND_ENDPOINT=http://127.0.0.1:$MAIL_PORT/emails"
  -e "MAIL_FROM_ADDRESS=no-reply@zfaf.app"
  -e "DEFAULT_MARKET=SA"
)

docker rm -f "$WEB_NAME" "$WORKER_NAME" >/dev/null 2>&1 || true
docker run -d --name "$WEB_NAME" --network=host -e "PORT=$WEB_PORT" "${container_env[@]}" "$WEB_IMAGE" >/dev/null

echo
echo "The web image"
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$WEB_PORT/api/health" && break
  sleep 1
done

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

[ "$(code "http://127.0.0.1:$WEB_PORT/api/health")" = 200 ] \
  && pass "answers /api/health" || fail "does not answer /api/health"

# Locale routing through the host-forwarding proxy — the container is bound to
# 0.0.0.0 and the Host it receives is not the name it bound to.
[ "$(code "http://127.0.0.1:$PROXY_PORT/")" = 200 ] \
  && pass "serves / behind a host-forwarding proxy (no 502, no loop)" || fail "/ is not served behind the proxy"
[ "$(code "http://127.0.0.1:$PROXY_PORT/en")" = 200 ] \
  && pass "serves /en" || fail "/en is not served"
[ "$(code "http://127.0.0.1:$PROXY_PORT/ar")" = 307 ] \
  && pass "redirects /ar to the unprefixed default exactly once" || fail "/ar does not redirect as expected"

# Registration proves the native password hasher resolves from the standalone
# tree — it did not, once, and answered 500 in a production build while working
# in development.
probe_email="smoke-$(date +%s)@example.com"
register=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 \
  -X POST "http://127.0.0.1:$PROXY_PORT/api/v1/auth/register" \
  -H 'content-type: application/json' -H 'origin: https://zfaf.app' \
  -H "x-forwarded-for: 198.51.100.$((RANDOM % 200 + 1))" \
  -d "{\"email\":\"$probe_email\",\"password\":\"a-long-enough-passphrase-1\",\"locale\":\"ar\"}")
[ "$register" = 201 ] && pass "registers an account (argon2 resolves in the image)" \
  || fail "registration answered $register"

sent_count="$(cat "$MAIL_LOG" 2>/dev/null || true)"
[ "${sent_count:-0}" -ge 1 ] \
  && pass "sent the verification email through the Resend adapter" \
  || fail "no email reached the sink"

web_log="$(docker logs "$WEB_NAME" 2>&1 || true)"
if grep -q '"event":"mail.sent"' <<<"$web_log" && ! grep -q "$probe_email" <<<"$web_log"; then
  pass "logged the send without the recipient (docs/15 §2)"
else
  fail "the mail log is missing, or carries the recipient"
fi

# The public page and its preview card. The card is rasterised from a font read
# at runtime, which nothing statically references — so this is the check that
# the file tracer carried it into the image.
# `pnpm --filter @zfaf/db exec tsx`, not `npx tsx`. The package that declares
# tsx is the one that can run it: on a fresh `--frozen-lockfile` install there
# is no `tsx` on any `.bin` path above apps/web, so `npx` would try to fetch it
# from the registry mid-check. That is how this failed on a runner while
# passing locally, where an earlier install had left a binary lying around.
seed_output="$(pnpm --filter @zfaf/db exec tsx "$ROOT/apps/web/e2e/fixtures/seed-one.ts" 2>&1 || true)"
slug="$(tail -1 <<<"$seed_output")"
if [ -n "$slug" ] && [[ "$slug" != *' '* ]]; then
  [ "$(code -H 'Host: zfaf.app' "http://127.0.0.1:$WEB_PORT/i/$slug")" = 200 ] \
    && pass "serves a published invitation" || fail "the published invitation is not served"
  og_type=$(curl -s -o /dev/null -w '%{content_type}' --max-time 30 -H 'Host: zfaf.app' "http://127.0.0.1:$WEB_PORT/i/$slug/og")
  [ "$og_type" = "image/png" ] \
    && pass "rasterises the preview card (the Arabic font is in the image)" \
    || fail "the preview card came back as '$og_type'"
else
  # The reason, not just the verdict. A check that cannot say why it failed
  # sends the next person to guess.
  fail "could not seed a published invitation to test against"
  tail -5 <<<"$seed_output" | sed 's/^/      /'
fi

# ── The worker ─────────────────────────────────────────────────────────────
echo
echo "The worker image"
docker run -d --name "$WORKER_NAME" --network=host "${container_env[@]}" "$WORKER_IMAGE" >/dev/null
sleep 12

worker_log="$(docker logs "$WORKER_NAME" 2>&1 || true)"
if grep -q 'media queue running' <<<"$worker_log"; then
  pass "starts and attaches to the media queue"
else
  fail "did not start"
  head -12 <<<"$worker_log"
fi

# The same command Render's preDeployCommand runs, from the same image.
if docker exec -w /app "$WORKER_NAME" pnpm --filter @zfaf/db db:deploy >/dev/null 2>&1; then
  pass "runs prisma migrate deploy from inside the image"
else
  fail "prisma migrate deploy failed inside the image"
fi

# A deploy sends SIGTERM. If it does not arrive, an in-flight encode is killed
# and its asset is left in `processing` for another worker to reclaim.
docker kill --signal=SIGTERM "$WORKER_NAME" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  [ "$(docker inspect -f '{{.State.Running}}' "$WORKER_NAME" 2>/dev/null)" = "false" ] && break
  sleep 1
done
shutdown_log="$(docker logs "$WORKER_NAME" 2>&1 || true)"
if [ "$(docker inspect -f '{{.State.ExitCode}}' "$WORKER_NAME" 2>/dev/null)" = "0" ] \
  && grep -q 'received SIGTERM' <<<"$shutdown_log"; then
  pass "shuts down gracefully on SIGTERM"
else
  fail "did not shut down gracefully on SIGTERM"
fi

# ── Verdict ────────────────────────────────────────────────────────────────
echo
if [ "$failures" -gt 0 ]; then
  echo "✖ $failures check(s) failed. Fix them before provisioning anything (docs/22 §4)."
  exit 1
fi
echo "✓ Both images build, run, and do the work. Provisioning is the next step, not before."
