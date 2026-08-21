# ADR-0024: Automatic Migration Application on Release

**Status:** Proposed (pending implementation)  
**Date:** 2026-08-21  
**Context:** [Orphaned media migration blocking uploads](../runbooks/apply-database-migrations.md)

---

## Problem

Schema changes are committed with migration files, but migrations must be manually triggered in CI via GitHub Actions for free-tier deployments. This is easy to forget, causing production outages when a service starts against a schema it hasn't seen.

**Concrete example:** 
- `20260820000000_add_orphaned_at_to_media_assets` created and tested locally
- Tests pass (`prisma migrate deploy` replays it)
- Committed to repository
- But production Neon database never gets the migration
- Service starts, tries to insert `orphanedAt` field, gets `P2022: Unknown column`

**Why tests didn't catch this:** Tests run migrations locally but don't verify migrations ran on the actual production database before the service started receiving traffic.

---

## Requirements

1. **Automatic:** `prisma migrate deploy` must run as part of the release process, not by manual GitHub Actions trigger
2. **Atomic:** Must run exactly once per release, not per instance
3. **Ordered:** Must complete BEFORE any service instance starts accepting requests
4. **Verified:** CI must fail if migrations can't run, preventing broken deploys
5. **Idempotent:** Running `prisma migrate deploy` twice must be safe (Prisma guarantees this via `_prisma_migrations` table)

---

## Solution

### For Free-Tier Deployments (Current: `zfaf-web-free` on Render)

**Since `preDeployCommand` is unavailable on free tier:**

Add an automated CI release step that:
1. Detects when a new commit is pushed to the deployment branch
2. Runs `prisma migrate deploy` against the test database (to verify migrations)
3. Automatically triggers the GitHub Actions migration workflow
4. **Waits** for the workflow to complete (use `ncipollo/github-actions-workflow-run-wait-action`)
5. Only then proceeds to Render deployment
6. Fails the entire CI run if migrations weren't applied

This keeps the free-tier deployment automatic while ensuring migrations are never skipped.

**Implementation:** Add a new CI stage or modify `.github/workflows/free-tier-fit.yml` (or create `free-tier-release.yml`)

### For Paid-Tier Deployments (Future: `render.yaml`)

**`preDeployCommand` is already specified:**

```yaml
preDeployCommand: pnpm --filter @zfaf/db db:deploy && pnpm --filter @zfaf/db db:templates
```

This runs in the worker service before ANY web service instance starts. No changes needed — this is the correct pattern.

---

## Non-Solution: Running Migrations in Entrypoint

**Why NOT to put in `web.Dockerfile` entrypoint:**

```dockerfile
ENTRYPOINT ["sh", "-c", "prisma migrate deploy && next start"]
```

Problems:
- If 10 service instances spin up concurrently (e.g., autoscaling), all 10 try to migrate
- First one acquires lock, others wait — but this is implicit and fragile
- If a migration fails, 10 instances all fail instead of 1 coordinated failure
- Each restart attempts migrations again (unnecessary churn)
- No way to distinguish "couldn't migrate" from "started with stale schema"

**Correct:** Run once, per-release, before any instance starts.

---

## Implementation Plan

### Phase 1: Add Pre-Flight Check (✅ Done)

- `scripts/check-pending-migrations.mjs` — fails the build if pending migrations exist
- `pnpm migrations:check` — manual check

### Phase 2: Automate Free-Tier Migrations (Pending)

**File:** `.github/workflows/free-tier-release.yml` (new)

```yaml
name: Free tier release — apply migrations & deploy

on:
  push:
    branches: [claude/wedding-invitation-saas-ecfcdg]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: pnpm

      - name: Verify migrations work locally
        env:
          DATABASE_URL: ${{ secrets.FREE_STACK_DATABASE_URL }}
        run: pnpm --filter @zfaf/db db:deploy

      - name: Trigger production migrations
        uses: ncipollo/github-actions-workflow-run-wait-action@v5
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          workflowId: free-stack-migrate.yml
          inputs: |
            confirm: neon-production
          timeoutMinutes: 10

      - name: Deploy to Render
        # ... existing Render deployment step
        run: # trigger render deployment
```

### Phase 3: Document Deployment Path (Pending)

Update `docs/14-cicd-and-deployment.md` §4 to show migration application order:

```
BEFORE ANY INSTANCE STARTS:
  1. CI runs tests, including `prisma migrate deploy` against test database
  2. CI automatically triggers and waits for production migrations
  3. CI verifies `/api/health` returns 200 before declaring success
  4. Only then: Render deploys service instances

RESULT:
  - Service starts against a schema it has already seen
  - All instances see the same schema version
  - Rollback is safe: old service can't run on new schema, so it won't start
```

---

## Consequences

**Positive:**
- Zero manual steps; migrations apply automatically
- Pushing a schema change automatically deploys it
- CI fails visibly if migrations can't run instead of silent production breakage
- Clear audit trail in workflow runs

**Negative:**
- More complex CI (adds workflow orchestration)
- Free-tier still requires workflow as coordinator (paid-tier avoids this entirely)
- Release blocker if migration takes >10min (rare, but needs timeout handling)

---

## Alternatives Considered

1. **Cron job that checks and applies migrations** — unsafe; no coordination with service deployments
2. **Migrations in entrypoint** — race conditions under load (rejected above)
3. **Paid-tier only** — ADR-0023 explicitly rejected this for cost reasons
4. **Keep manual workflow** — current state; leads to forgotten deployments

---

## References

- docs/25-zero-cost-deployment.md §3.1 (free-tier limitations)
- render.yaml (paid-tier `preDeployCommand`)
- `.github/workflows/free-stack-migrate.yml` (manual workflow)
- `scripts/check-pending-migrations.mjs` (pre-flight check)
