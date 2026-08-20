-- Add orphaned_at field to track when media assets become orphaned (detached from deleted invitations)
ALTER TABLE "media_assets" ADD COLUMN "orphaned_at" TIMESTAMP(3);

-- Index for the daily purge job that cleans up orphaned media older than 7 days
CREATE INDEX "media_assets_orphaned_at_idx" ON "media_assets"("orphaned_at");
