-- The upload-size ceiling that was bound into the presigned URL.
--
-- Stored rather than recomputed when the upload completes: entitlements can
-- change during the fifteen minutes a signature is valid, and a plan downgrade
-- must not retroactively quarantine a file that was within the limit when its
-- URL was issued.
--
-- Backfilled from the recorded size before the NOT NULL is applied. Existing
-- rows predate the column, so their signed ceiling is unknown; using the size
-- already accepted is the only value that cannot invalidate a stored object.
ALTER TABLE "media_assets" ADD COLUMN "signed_max_bytes" BIGINT;

UPDATE "media_assets" SET "signed_max_bytes" = GREATEST("size_bytes", 1) WHERE "signed_max_bytes" IS NULL;

ALTER TABLE "media_assets" ALTER COLUMN "signed_max_bytes" SET NOT NULL;

-- A ceiling of zero or less would make every upload fail the completion check.
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_signed_max_bytes_positive" CHECK ("signed_max_bytes" > 0);
