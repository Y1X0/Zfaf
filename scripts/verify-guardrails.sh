#!/usr/bin/env bash
#
# Proves that the architectural guardrails actually fail the build.
#
# A lint rule that is configured but never exercised is a rule nobody notices
# has broken. This script writes deliberately non-compliant files, asserts that
# the tooling rejects each one, and removes them again. It is a required CI
# check (see M0 acceptance criteria in docs/20-phase1-milestones.md).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP_DIR="$(mktemp -d)"
CREATED_FILES=()

cleanup() {
  for file in "${CREATED_FILES[@]:-}"; do
    [ -n "$file" ] && rm -f "$file"
  done
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

failures=0

# write_violation <path> <content>
write_violation() {
  local path="$1"
  local content="$2"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$content" > "$path"
  CREATED_FILES+=("$path")
}

# expect_boundary_rejected <label> <file> <expected-rule-name>
#
# The dependency-cruiser rules are checked the same way as the ESLint ones and
# for the same reason: a boundary that is configured but never exercised is a
# boundary nobody notices has broken. These three keep a native or
# vendor-specific dependency inside the one adapter that owns it.
expect_boundary_rejected() {
  local label="$1"
  local file="$2"
  local expected="$3"
  local output

  if ! output="$(pnpm exec depcruise --config .dependency-cruiser.cjs "$file" 2>&1)"; then
    if printf '%s' "$output" | grep -q "$expected"; then
      echo "  ✓ $label"
      return
    fi
    echo "  ✗ $label — rejected, but not by \"$expected\""
    printf '%s\n' "$output" | head -5
    failures=$((failures + 1))
    return
  fi

  echo "  ✗ $label — dependency-cruiser ACCEPTED a file it must reject"
  echo "      file: $file"
  failures=$((failures + 1))
}

# expect_rejected <label> <file> <expected-rule-substring>
expect_rejected() {
  local label="$1"
  local file="$2"
  local expected="$3"
  local output

  if output="$(pnpm exec eslint "$file" --no-warn-ignored 2>&1)"; then
    echo "  ✗ $label — ESLint ACCEPTED a file it must reject"
    echo "      file: $file"
    failures=$((failures + 1))
    return
  fi

  if ! grep -q "$expected" <<< "$output"; then
    echo "  ✗ $label — rejected, but not by the expected rule ($expected)"
    echo "$output" | sed 's/^/      /'
    failures=$((failures + 1))
    return
  fi

  echo "  ✓ $label"
}

echo "Verifying architecture guardrails…"
echo

# ── ADR-0003 / ADR-0001: the domain core stays ORM-free ─────────────────────
write_violation "packages/core/src/__guardrail_prisma.ts" \
  'import { PrismaClient } from "@prisma/client";
export const client = new PrismaClient();'
expect_rejected "Prisma import inside packages/core is rejected" \
  "packages/core/src/__guardrail_prisma.ts" \
  "zfaf/no-prisma-outside-db"

# ── ADR-0011: physical CSS properties break RTL ─────────────────────────────
write_violation "apps/web/src/__guardrail_css.ts" \
  'export const style = { marginLeft: "1rem" };'
expect_rejected "Physical CSS property in apps/web is rejected" \
  "apps/web/src/__guardrail_css.ts" \
  "zfaf/no-physical-css-properties"

write_violation "apps/web/src/__guardrail_tailwind.ts" \
  'export const className = "flex ml-4 items-center";'
expect_rejected "Physical Tailwind utility in apps/web is rejected" \
  "apps/web/src/__guardrail_tailwind.ts" \
  "zfaf/no-physical-css-properties"

# ── ADR-0015: markets are configuration, not literals ───────────────────────
write_violation "apps/web/src/__guardrail_market.ts" \
  'export const currency = "SAR";
export const timezone = "Asia/Riyadh";'
expect_rejected "Hard-coded market values are rejected" \
  "apps/web/src/__guardrail_market.ts" \
  "zfaf/no-market-literals"

# ── ADR-0008: no tax logic before a specialist has verified it ──────────────
write_violation "packages/core/src/__guardrail_tax.ts" \
  'const VAT_RATE = 0.15;
export const rate = VAT_RATE;'
expect_rejected "Hard-coded tax constant is rejected" \
  "packages/core/src/__guardrail_tax.ts" \
  "zfaf/no-market-literals"

# ── ADR-0004: user content is never raw HTML ────────────────────────────────
write_violation "apps/web/src/__guardrail_html.tsx" \
  'export const props = { dangerouslySetInnerHTML: { __html: "x" } };'
expect_rejected "dangerouslySetInnerHTML is rejected" \
  "apps/web/src/__guardrail_html.tsx" \
  "zfaf/no-dangerous-html"

# ── ADR-0002: the core must not depend on a framework ───────────────────────
write_violation "packages/core/src/__guardrail_framework.ts" \
  'import { NextResponse } from "next/server";
export const r = NextResponse;'
expect_rejected "Framework import inside packages/core is rejected" \
  "packages/core/src/__guardrail_framework.ts" \
  "no-restricted-imports"

# ── ADR-0004: the render path stays deterministic ───────────────────────────
write_violation "packages/core/src/__guardrail_clock.ts" \
  'export const stamp = Date.now();'
expect_rejected "Date.now() inside packages/core is rejected" \
  "packages/core/src/__guardrail_clock.ts" \
  "no-restricted-properties"

# ── ADR-0014: feature access is never a plan-name comparison ────────────────
write_violation "apps/web/src/__guardrail_plan.ts" \
  'declare const user: { plan: string };
export const allowed = user.plan === "premium";'
expect_rejected "Branching on a plan name is rejected" \
  "apps/web/src/__guardrail_plan.ts" \
  "no-restricted-syntax"

# ── ADR-0007 amendment: the storage SDK stays in its adapter ────────────────
write_violation "packages/core/src/__guardrail_s3.ts" \
  'import { S3Client } from "@aws-sdk/client-s3";
export const client = S3Client;'
expect_boundary_rejected "AWS SDK outside packages/infra/src/storage is rejected" \
  "packages/core/src/__guardrail_s3.ts" \
  "storage-sdk-stays-in-its-adapter"

# ── the image library belongs to the processing adapter ─────────────────────
write_violation "packages/core/src/__guardrail_sharp.ts" \
  'import sharp from "sharp";
export const resize = sharp;'
expect_boundary_rejected "Sharp outside apps/worker/src/media is rejected" \
  "packages/core/src/__guardrail_sharp.ts" \
  "image-library-stays-in-the-worker"

# The same rule from inside the package that *declares* Sharp, so the pnpm
# virtual-store resolution path is exercised rather than only the
# bare-specifier one.
write_violation "apps/worker/src/__guardrail_sharp_resolved.ts" \
  'import sharp from "sharp";
export const resize = sharp;'
expect_boundary_rejected "Sharp elsewhere in the worker is rejected" \
  "apps/worker/src/__guardrail_sharp_resolved.ts" \
  "image-library-stays-in-the-worker"

# ── ADR-0019: the HEIC decoder is imported in exactly one module ────────────
write_violation "apps/worker/src/__guardrail_heif.ts" \
  'import { HeifDecoder } from "libheif-js";
export const decoder = HeifDecoder;'
expect_boundary_rejected "libheif-js outside its own module is rejected" \
  "apps/worker/src/__guardrail_heif.ts" \
  "heic-decoder-stays-in-its-module"

# ── docs/22 §4: the provisioner refuses a field it cannot send ──────────────
#
# `render.yaml` is the reviewed artefact, and the provisioner's whole claim is
# that what runs is what was reviewed. That claim rests on one rule: a key it
# does not know how to send stops the run instead of being dropped. The failure
# it prevents is the silent one — a blueprint saying `ipAllowList: []` and a
# database created open to the internet.
#
# Checked here rather than in CI-by-hope, because `--mode check` reads a file
# and talks to nothing: no API key, no network, no resource.
echo
echo "Render blueprint:"

if output="$(node scripts/render-provision.mjs --mode check 2>&1)"; then
  echo "  ✓ render.yaml declares only fields the provisioner can send"
else
  echo "  ✗ the provisioner refuses the committed render.yaml"
  printf '%s\n' "$output" | head -10
  failures=$((failures + 1))
fi

# And the same guard against a blueprint that smuggles one in. `diskSizeGB` is
# a real Render field this provisioner does not send — exactly the shape of
# thing that must fail loudly rather than be created without.
BAD_BLUEPRINT="$TMP_DIR/render-unknown-field.yaml"
sed 's|^    plan: standard$|    plan: standard\n    diskSizeGB: 20|' render.yaml > "$BAD_BLUEPRINT"

if output="$(node scripts/render-provision.mjs --mode check --blueprint "$BAD_BLUEPRINT" 2>&1)"; then
  echo "  ✗ the provisioner ACCEPTED a blueprint field it cannot send"
  failures=$((failures + 1))
elif printf '%s' "$output" | grep -q 'diskSizeGB'; then
  echo "  ✓ an unknown blueprint field is refused by name"
else
  echo "  ✗ refused, but without naming the offending field"
  printf '%s\n' "$output" | head -10
  failures=$((failures + 1))
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "✗ $failures guardrail(s) did not hold. The architecture is no longer enforced."
  exit 1
fi

echo "✓ All guardrails hold."
