#!/usr/bin/env bash
#
# Interrogates a running deployment. Reads only — never writes.
#
# The companion to `docker:smoke`, and the difference between them is the
# safety posture rather than the subject. `docker:smoke` registers accounts,
# seeds an invitation and runs sweeps, so it refuses any database that is not
# local. This one is pointed at a **real deployment**, so every request it makes
# is a GET or a HEAD against something a visitor could ask for anyway. It signs
# nobody in, creates nothing, and mutates nothing.
#
#   bash scripts/verify-deployment.sh https://zfaf-web-xxxx.onrender.com
#
# Optional:
#   HEALTH_CHECK_TOKEN=…   also asserts the deep probe names its components for
#                          a caller holding the token, and refuses to for one
#                          who is not.
#   SLUG=…                 a published invitation to check, with its preview
#                          card. Create it through the interface first; this
#                          script will not.
#   INSECURE_TLS=1         accept a self-signed certificate. For pointing this
#                          at a local server, never at a deployment — a real
#                          one has a real certificate and a broken chain there
#                          is a finding.
#
# Run it against the platform's own hostname before any DNS points at it
# (docs/22 §9). A green run is not the whole acceptance list: the parts that
# require writing — sign-in, publishing, RSVP — belong on a staging database,
# not on the first production deployment.
#
set -euo pipefail

BASE="${1:-${DEPLOYMENT_URL:-}}"
if [ -z "$BASE" ]; then
  echo "usage: bash scripts/verify-deployment.sh <base-url>" >&2
  exit 2
fi
BASE="${BASE%/}"

CURL=(curl -sS --max-time 30)
[ "${INSECURE_TLS:-0}" = "1" ] && CURL+=(-k)

failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; failures=$((failures + 1)); }
skip() { printf '  \033[33m·\033[0m %s\n' "$1"; }

# Every request below is a read. `-X GET` is never overridden anywhere in this
# file, and that is the property that makes it safe to point at production.
code() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@"; }
body() { "${CURL[@]}" "$@"; }
headers() { "${CURL[@]}" -D - -o /dev/null "$@"; }

echo
echo "Deployment: $BASE"
echo
echo "Liveness and readiness"

[ "$(code "$BASE/api/health")" = 200 ] \
  && pass "/api/health answers 200" || fail "/api/health did not answer 200"

grep -q '"status":"ok"' <<<"$(body "$BASE/api/health")" \
  && pass "reports itself healthy" || fail "the health body is not ok"

# The deep probe is the one that must stay quiet for strangers: naming the
# component that is down tells an attacker when to try (docs/14 §11).
deep_anon="$(body "$BASE/api/health/deep")"
if grep -q '"components"' <<<"$deep_anon"; then
  fail "the deep probe names its components to an unauthenticated caller"
else
  pass "the deep probe gives a verdict only, without a token"
fi

if [ -n "${HEALTH_CHECK_TOKEN:-}" ]; then
  deep_auth="$(body -H "authorization: Bearer $HEALTH_CHECK_TOKEN" "$BASE/api/health/deep")"
  if grep -q '"components"' <<<"$deep_auth"; then
    pass "names its components for a caller holding the token"
    # Each component named, with its own verdict. `error_tracking` counts:
    # a deployment whose errors go nowhere is one where the first incident is
    # discovered by a customer.
    for component in database redis error_tracking; do
      fragment="$(grep -o "\"name\":\"$component\"[^}]*" <<<"$deep_auth" || true)"
      status="$(grep -o '"status":"[a-z]*"' <<<"$fragment" | head -1 | cut -d'"' -f4 || true)"
      detail="$(grep -o '"detail":"[^"]*"' <<<"$fragment" | head -1 | cut -d'"' -f4 || true)"
      case "$status" in
        ok) pass "  $component: ok" ;;
        '') fail "  $component: not reported by the probe" ;;
        *)  fail "  $component: $status${detail:+ — $detail}" ;;
      esac
    done
  else
    fail "the token was rejected, or the probe answers the same either way"
  fi
else
  skip "HEALTH_CHECK_TOKEN unset — component detail not checked"
fi

echo
echo "Locale routing (D9.1)"

# The question this whole section exists for: the container binds 0.0.0.0 and
# the platform forwards a hostname it never bound to. If Next treats the locale
# rewrite as external it re-requests it over the network, which surfaces as a
# 502, a redirect loop, or a TLS error against its own port.
root_code="$(code "$BASE/")"
[ "$root_code" = 200 ] && pass "/ answers 200 (no 502, no loop)" \
  || fail "/ answered $root_code"

hops="$("${CURL[@]}" -o /dev/null -L -w '%{num_redirects}' "$BASE/")"
[ "$hops" -le 1 ] && pass "/ settles in $hops redirect(s)" \
  || fail "/ took $hops redirects — that is the loop D9.1 produced"

root_html="$(body -L "$BASE/")"
grep -q 'lang="ar"' <<<"$root_html" && grep -q 'dir="rtl"' <<<"$root_html" \
  && pass "/ is Arabic and right-to-left" || fail "/ is not the Arabic document"

[ "$(code "$BASE/en")" = 200 ] && pass "/en answers 200" || fail "/en did not answer 200"
grep -q 'lang="en"' <<<"$(body -L "$BASE/en")" \
  && pass "/en is the English document" || fail "/en is not the English document"

ar_code="$(code "$BASE/ar")"
[ "$ar_code" = 307 ] || [ "$ar_code" = 308 ] \
  && pass "/ar redirects to the unprefixed default ($ar_code)" \
  || fail "/ar answered $ar_code"

[ "$(code "$BASE/xx")" = 404 ] \
  && pass "an unknown locale is a real 404" || fail "an unknown locale is not a 404"

echo
echo "Response hygiene"

head_root="$(headers "$BASE/")"
for header in x-content-type-options x-frame-options referrer-policy permissions-policy; do
  grep -qi "^$header:" <<<"$head_root" \
    && pass "sends $header" || fail "does not send $header"
done

grep -qi '^x-powered-by:' <<<"$head_root" \
  && fail "advertises x-powered-by" || pass "does not advertise its framework"

# HSTS belongs at the edge once the domain is attached; before that it is
# absence, not a defect.
if grep -qi '^strict-transport-security:' <<<"$head_root"; then
  pass "sends HSTS"
else
  skip "no HSTS yet — expected until the domain is attached at the edge (docs/22 §7)"
fi

echo
echo "The public surface"

if [ -n "${SLUG:-}" ]; then
  invitation="$BASE/i/$SLUG"
  [ "$(code "$invitation")" = 200 ] \
    && pass "serves the published invitation" || fail "the published invitation is not served"

  head_invitation="$(headers "$invitation")"
  grep -qi '^cache-control:.*s-maxage' <<<"$head_invitation" \
    && pass "is cacheable at the edge (s-maxage)" || fail "carries no s-maxage — the CDN would not cache it"
  grep -qi '^cache-tag:' <<<"$head_invitation" \
    && pass "stamps a cache-tag" || fail "stamps no cache-tag"

  og_type="$("${CURL[@]}" -o /dev/null -w '%{content_type}' "$invitation/og")"
  [ "$og_type" = "image/png" ] \
    && pass "rasterises the preview card as PNG" || fail "the preview card came back as '$og_type'"
else
  skip "SLUG unset — publish an invitation through the interface, then re-run"
fi

# A slug nobody published must be a 404 rather than a 500: a stack trace here
# is both an information leak and a sign the database is unreachable.
absent="$(code "$BASE/i/definitely-not-a-real-invitation")"
[ "$absent" = 404 ] \
  && pass "an unpublished address is a 404, not a 500" || fail "an unpublished address answered $absent"

echo
echo "Authorization, from outside"

# One unauthenticated read against an endpoint that requires a session. It
# creates nothing and signs nobody in; it only proves the door is shut.
#
# `/api/v1/auth/session` and not an invitation route, deliberately: a private
# invitation answers 404 to a stranger by design (an id that exists must not be
# distinguishable from one that does not), so a 404 there would prove nothing
# either way. This endpoint's whole job is to say who you are, and to an
# anonymous caller the answer is 401.
private="$(code "$BASE/api/v1/auth/session")"
{ [ "$private" = 401 ] || [ "$private" = 403 ]; } \
  && pass "a session-required endpoint refuses an anonymous caller ($private)" \
  || fail "a session-required endpoint answered $private to an anonymous caller"

echo
if [ "$failures" -gt 0 ]; then
  echo "✖ $failures check(s) failed. Do not attach the domain (docs/22 §7)."
  exit 1
fi
echo "✓ The deployment answers correctly on every read-only check."
echo "  Still owed before launch: the write paths on a staging database, the"
echo "  nineteen locale tests via E2E_BASE_URL (docs/22 §6), and a real email"
echo "  landing in a real inbox (docs/22 §8)."
