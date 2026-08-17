#!/usr/bin/env bash
#
# Backup and restore drill (D10.7, docs/15 §9).
#
# The Definition of Done says the backup must be "tested by at least one real
# restore". This is that test, made repeatable so it is not a thing somebody
# did once in 2026 and remembers fondly.
#
# What it proves, in order:
#
#   1. A dump can be taken from a live database.
#   2. A brand-new database can be built from **every migration from empty** —
#      the same path a new environment takes, not just the current schema.
#   3. The dump restores into it.
#   4. The restored data is *intact*, not merely present: every published
#      snapshot is re-hashed and compared against its recorded checksum
#      (ADR-0005). Row counts say the rows arrived; the checksum says they are
#      the same rows.
#
# It never touches the source database, and it drops its scratch database on
# the way out even when a step fails.
#
#   DATABASE_URL=postgresql://... bash scripts/backup-restore-drill.sh
#
set -euo pipefail

SOURCE_URL="${DATABASE_URL:-postgresql://zfaf:zfaf_local_dev@127.0.0.1:5432/zfaf?schema=public}"
WORK="$(mktemp -d)"
STAMP="$(date -u +%Y%m%d%H%M%S)"
SCRATCH_DB="zfaf_drill_${STAMP}"

# libpq rejects Prisma's `?schema=` parameter, so the tools get a URL without
# it. Prisma keeps the full one — the two disagree about query syntax, not
# about which database they mean.
LIBPQ_URL="${SOURCE_URL%%\?*}"
BASE_URL="${LIBPQ_URL%/*}"
SCRATCH_URL="${BASE_URL}/${SCRATCH_DB}"
# `postgres` rather than the scratch database: you cannot drop the database you
# are connected to.
ADMIN_URL="${BASE_URL}/postgres"

cleanup() {
  local status=$?
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "1/5  Dumping the source database"
# Custom format: parallel-restorable and selective, which is what a real
# recovery needs when only part of the data is wanted.
pg_dump --format=custom --no-owner --no-acl --file="$WORK/backup.dump" "$LIBPQ_URL"
DUMP_BYTES=$(stat -c %s "$WORK/backup.dump")
printf '     %s bytes\n' "$DUMP_BYTES"

if [ "$DUMP_BYTES" -lt 1024 ]; then
  echo "✗ The dump is implausibly small. A backup nobody looked at is not a backup." >&2
  exit 1
fi

step "2/5  Creating an empty database and applying every migration from scratch"
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"${SCRATCH_DB}\""
# Not `db push`, and not the dump's own schema: this exercises the migration
# history the way a new environment does, so a migration that only works
# against an existing database fails here rather than in production.
DATABASE_URL="$SCRATCH_URL" pnpm --filter @zfaf/db exec prisma migrate deploy >/dev/null
DATABASE_URL="$SCRATCH_URL" pnpm --filter @zfaf/db exec prisma migrate status | tail -1

step "3/5  Restoring the dump over it"
# `--data-only` because the schema is already there from the migrations, which
# is the combination that proves both halves rather than only the dump.
# `--disable-triggers` because `audit_logs` and `invitation_versions` carry
# triggers that (correctly) reject writes that are not inserts from the app.
pg_restore --data-only --disable-triggers --no-owner --no-acl \
  --dbname="$SCRATCH_URL" "$WORK/backup.dump" 2>"$WORK/restore.log" || {
  # pg_restore warns about ordering it resolved itself; only errors matter.
  if grep -qi 'error' "$WORK/restore.log"; then
    echo "✗ Restore reported errors:" >&2
    cat "$WORK/restore.log" >&2
    exit 1
  fi
}

step "4/5  Comparing what arrived against what was there"
compare() {
  local table="$1"
  local before after
  before=$(psql "$LIBPQ_URL" -tA -c "SELECT count(*) FROM ${table}")
  after=$(psql "$SCRATCH_URL" -tA -c "SELECT count(*) FROM ${table}")
  printf '     %-24s source %-8s restored %-8s' "$table" "$before" "$after"
  if [ "$before" = "$after" ]; then
    printf '✓\n'
  else
    printf '✗\n'
    return 1
  fi
}

FAILED=0
for table in users invitations invitation_versions rsvps sessions audit_logs media_assets; do
  compare "$table" || FAILED=1
done
[ "$FAILED" -eq 0 ] || { echo "✗ Row counts differ." >&2; exit 1; }

step "5/5  Verifying published snapshots still hash to what was recorded"
# The check that separates "the rows arrived" from "the rows are unchanged".
DATABASE_URL="$SCRATCH_URL" pnpm --filter @zfaf/db exec tsx prisma/verify-checksums.ts

cat <<REPORT

────────────────────────────────────────────────────────────────
Restore drill complete.

  dump              ${DUMP_BYTES} bytes
  migrations        applied from empty
  data              restored and row-for-row equal
  snapshots         checksums verified (ADR-0005)
  scratch database  ${SCRATCH_DB} (dropped on exit)

Record the date, the operator and the elapsed time in
docs/runbooks/restore-backup.md. A drill nobody wrote down is a
drill that did not happen.
────────────────────────────────────────────────────────────────
REPORT
