# Applying Database Migrations to Production

**When to use this:** When a new database migration has been created (`packages/db/prisma/migrations/`) but hasn't been applied to the production database yet.

**How to detect:** Schema changes are committed to the repository, but image uploads (or other operations) fail with `P2022: Unknown column` errors.

---

## Quick Status Check

```bash
# See how many migrations exist locally
ls packages/db/prisma/migrations/ | grep -v migration_lock | wc -l

# Check which migrations are pending
DATABASE_URL="<your-neon-url>" pnpm --filter @zfaf/db exec prisma migrate status
```

---

## Step 1: Trigger Migration via GitHub Actions

**For free-tier deployments only** (currently active on `zfaf-web-free`):

1. Go to: https://github.com/y1x0/zfaf/actions/workflows/free-stack-migrate.yml
2. Click the green **"Run workflow"** button (top right)
3. In the dropdown, keep the branch as `claude/wedding-invitation-saas-ecfcdg`
4. Fill the **"Confirm"** field with the database name you're targeting:
   - **`neon-production`** (for the live Neon database)
   - Or a staging database name if testing first
5. Click **"Run workflow"** again to confirm
6. Wait for the workflow to complete (~2 minutes)

**Success indicators:**
- ✅ All three workflow steps complete (✓ record what's being applied, ✓ apply migrations, ✓ publish template library twice)
- ✅ No error messages in the run log
- ✅ The run shows green checkmark status

---

## Step 2: Verify the Migration Was Applied

**In the GitHub Actions log:**
```
✓ Apply migrations
  ...
  ✓ db:deploy
  ...
  ✓ Publish the template library (×2)
```

**In your application:**
- Attempt an image upload
- Watch the Network tab for the `PUT` request to B2
- Verify the upload succeeds (HTTP 200)
- Check the `/i/<slug>?debug=1` debug box for "Upload successful" message

**Direct verification (if you have Neon access):**
```sql
SELECT column_name 
FROM information_schema.columns 
WHERE table_name='media_assets' AND column_name='orphaned_at';
-- Should return one row: orphaned_at
```

---

## Step 3: Deploy the Application

Once migrations are applied, the web service can deploy safely:

```bash
# Trigger a new deployment on Render (or your platform)
# The service will start against a schema it has already seen
```

---

## If Something Goes Wrong

### "Target database not found"
- Confirm you typed the correct database name (e.g., `neon-production` not `Neon-Production`)
- The workflow logs will say which name it tried

### "Migration failed: column already exists"
- The migration may have been applied already
- Run the verification query above to confirm `orphaned_at` exists
- If it does, no action needed — the error is safe to ignore

### "Template library validation failed"
- A template manifest changed without a version bump (ADR-0005)
- Look at the workflow logs for which manifest is the problem
- Increment its version number in `manifest.json` and retry

---

## Long-term: Prevent This From Happening Again

**Why this is needed:** New migrations created locally won't reach production until someone manually triggers the workflow. This is easy to forget.

**Proposed solutions (for future PRs):**

1. **Add migration check to CI:** Automatically fail builds if migrations exist locally but haven't been applied to a test database
2. **Auto-trigger workflow:** Create a CI step that automatically triggers `free-stack-migrate` when new migrations are detected
3. **Upgrade to paid tier:** If using `render.yaml` (paid deployment), migrations run automatically via `preDeployCommand` before the service starts

---

## Reference

- **Free-stack migration workflow:** `.github/workflows/free-stack-migrate.yml`
- **Migration directory:** `packages/db/prisma/migrations/`
- **Prisma schema:** `packages/db/prisma/schema.prisma`
- **Paid-tier blueprint:** `render.yaml` (includes `preDeployCommand: pnpm --filter @zfaf/db db:deploy`)
- **Docs:** `docs/27-zero-cost-deployment.md` §6 (GitHub Actions migrations)
