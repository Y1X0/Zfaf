-- Zfaf — Phase 1 initial schema.
--
-- Hand-extended after generation with the constraints Prisma cannot express:
-- required extensions, the partial unique index on slug, immutability triggers,
-- and check constraints. Those pieces are where the real invariants live.

-- citext: case-insensitive email and slug comparison without per-query LOWER().
CREATE EXTENSION IF NOT EXISTS citext;
-- pgcrypto: digest() for checksums computed in SQL.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('customer', 'planner', 'support', 'admin', 'superadmin');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended', 'pending_deletion');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('draft', 'published', 'deprecated');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'EXPIRED', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "InvitationVisibility" AS ENUM ('UNLISTED', 'INDEXED', 'PROTECTED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('owner', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('contract', 'reception', 'wedding', 'dinner', 'custom');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('image', 'audio');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('pending', 'processing', 'ready', 'failed', 'quarantined');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('pending', 'clean', 'infected', 'skipped');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'expired');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "password_hash" TEXT,
    "name" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'ar',
    "market_code" CHAR(2) NOT NULL DEFAULT 'SA',
    "role" "UserRole" NOT NULL DEFAULT 'customer',
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "suspended_reason" TEXT,
    "suspended_at" TIMESTAMPTZ(3),
    "deletion_requested_at" TIMESTAMPTZ(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "storage_used_bytes" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "ip_hash" BYTEA,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "email" CITEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name_i18n" JSONB NOT NULL,
    "description_i18n" JSONB NOT NULL,
    "category" TEXT NOT NULL,
    "preview_image_key" TEXT,
    "required_plan_level" INTEGER NOT NULL DEFAULT 0,
    "status" "TemplateStatus" NOT NULL DEFAULT 'draft',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "current_version_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_versions" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "manifest_checksum" TEXT NOT NULL,
    "changelog" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "slug" CITEXT,
    "title" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'DRAFT',
    "template_id" UUID NOT NULL,
    "template_version_id" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'ar',
    "market_code" CHAR(2) NOT NULL DEFAULT 'SA',
    "event_date" DATE NOT NULL,
    "event_start_time" TEXT,
    "event_end_time" TEXT,
    "timezone" TEXT NOT NULL,
    "draft_document" JSONB NOT NULL,
    "draft_version" INTEGER NOT NULL DEFAULT 1,
    "published_version_id" UUID,
    "visibility" "InvitationVisibility" NOT NULL DEFAULT 'UNLISTED',
    "password_hash" TEXT,
    "rsvp_enabled" BOOLEAN NOT NULL DEFAULT true,
    "rsvp_deadline" DATE,
    "max_party_size" INTEGER NOT NULL DEFAULT 5,
    "view_count" BIGINT NOT NULL DEFAULT 0,
    "rsvp_yes_count" INTEGER NOT NULL DEFAULT 0,
    "rsvp_no_count" INTEGER NOT NULL DEFAULT 0,
    "rsvp_guest_count" INTEGER NOT NULL DEFAULT 0,
    "suspended_reason" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_versions" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "published_document" JSONB NOT NULL,
    "document_checksum" TEXT NOT NULL,
    "template_version_id" UUID NOT NULL,
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation_members" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "invited_by" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slug_history" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "oldSlug" CITEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserved_slugs" (
    "slug" CITEXT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "reserved_slugs_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "type" "EventType" NOT NULL,
    "title_i18n" JSONB NOT NULL,
    "description_i18n" JSONB,
    "event_date" DATE NOT NULL,
    "start_time" TEXT,
    "end_time" TEXT,
    "timezone" TEXT NOT NULL,
    "venue_name" TEXT,
    "venue_address" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(10,6),
    "maps_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "invitation_id" UUID,
    "kind" "MediaKind" NOT NULL,
    "purpose" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "blurhash" TEXT,
    "variants" JSONB NOT NULL DEFAULT '{}',
    "status" "MediaStatus" NOT NULL DEFAULT 'pending',
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "music_tracks" (
    "id" UUID NOT NULL,
    "title_i18n" JSONB NOT NULL,
    "artist" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "license_type" TEXT NOT NULL,
    "license_url" TEXT NOT NULL,
    "license_proof_url" TEXT NOT NULL,
    "attribution_required" BOOLEAN NOT NULL DEFAULT false,
    "attribution_text" TEXT,
    "required_plan_level" INTEGER NOT NULL DEFAULT 0,
    "mood" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "music_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rsvps" (
    "id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "attending" BOOLEAN NOT NULL,
    "party_size" INTEGER NOT NULL DEFAULT 1,
    "phone" TEXT,
    "note" TEXT,
    "dedupe_hash" BYTEA NOT NULL,
    "edit_token_hash" BYTEA,
    "source" TEXT NOT NULL DEFAULT 'public',
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rsvps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "name_i18n" JSONB NOT NULL,
    "price_amount" INTEGER,
    "currency" CHAR(3),
    "billing_period" TEXT,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "invitation_id" UUID,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "current_period_start" TIMESTAMPTZ(3) NOT NULL,
    "current_period_end" TIMESTAMPTZ(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'null',
    "provider_subscription_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement_overrides" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "feature" TEXT,
    "limit_key" TEXT,
    "numeric_value" INTEGER,
    "bool_value" BOOLEAN,
    "reason" TEXT NOT NULL,
    "granted_by" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" BIGSERIAL NOT NULL,
    "invitation_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "visitor_hash" BYTEA NOT NULL,
    "device_class" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_hash" BYTEA,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deletion_requested_at_idx" ON "users"("deletion_requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_provider_account_id_key" ON "oauth_accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verifications_token_hash_key" ON "email_verifications"("token_hash");

-- CreateIndex
CREATE INDEX "email_verifications_user_id_idx" ON "email_verifications"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- CreateIndex
CREATE INDEX "password_resets_user_id_idx" ON "password_resets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "templates_key_key" ON "templates"("key");

-- CreateIndex
CREATE INDEX "templates_status_sort_order_idx" ON "templates"("status", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_id_version_key" ON "template_versions"("template_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_published_version_id_key" ON "invitations"("published_version_id");

-- CreateIndex
CREATE INDEX "invitations_owner_id_status_created_at_idx" ON "invitations"("owner_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "invitations_expires_at_idx" ON "invitations"("expires_at");

-- CreateIndex
CREATE INDEX "invitations_event_date_idx" ON "invitations"("event_date");

-- CreateIndex
CREATE INDEX "invitation_versions_invitation_id_published_at_idx" ON "invitation_versions"("invitation_id", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_versions_invitation_id_version_number_key" ON "invitation_versions"("invitation_id", "version_number");

-- CreateIndex
CREATE INDEX "invitation_members_user_id_idx" ON "invitation_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_members_invitation_id_user_id_key" ON "invitation_members"("invitation_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "slug_history_oldSlug_key" ON "slug_history"("oldSlug");

-- CreateIndex
CREATE INDEX "slug_history_invitation_id_idx" ON "slug_history"("invitation_id");

-- CreateIndex
CREATE INDEX "events_invitation_id_sort_order_idx" ON "events"("invitation_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"("storage_key");

-- CreateIndex
CREATE INDEX "media_assets_owner_id_created_at_idx" ON "media_assets"("owner_id", "created_at");

-- CreateIndex
CREATE INDEX "media_assets_invitation_id_idx" ON "media_assets"("invitation_id");

-- CreateIndex
CREATE INDEX "media_assets_status_idx" ON "media_assets"("status");

-- CreateIndex
CREATE UNIQUE INDEX "music_tracks_storage_key_key" ON "music_tracks"("storage_key");

-- CreateIndex
CREATE INDEX "music_tracks_is_active_required_plan_level_idx" ON "music_tracks"("is_active", "required_plan_level");

-- CreateIndex
CREATE INDEX "rsvps_invitation_id_submitted_at_idx" ON "rsvps"("invitation_id", "submitted_at");

-- CreateIndex
CREATE INDEX "rsvps_invitation_id_attending_idx" ON "rsvps"("invitation_id", "attending");

-- CreateIndex
CREATE UNIQUE INDEX "rsvps_invitation_id_dedupe_hash_key" ON "rsvps"("invitation_id", "dedupe_hash");

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE INDEX "plans_is_active_sort_order_idx" ON "plans"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "entitlement_overrides_user_id_expires_at_idx" ON "entitlement_overrides"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "analytics_events_invitation_id_occurred_at_idx" ON "analytics_events"("invitation_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_versions" ADD CONSTRAINT "invitation_versions_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_versions" ADD CONSTRAINT "invitation_versions_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_versions" ADD CONSTRAINT "invitation_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_members" ADD CONSTRAINT "invitation_members_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation_members" ADD CONSTRAINT "invitation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slug_history" ADD CONSTRAINT "slug_history_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement_overrides" ADD CONSTRAINT "entitlement_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Constraints and invariants that Prisma's schema language cannot express.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Slug uniqueness ────────────────────────────────────────────────────────
-- Partial, so a deleted invitation releases its slug while a live one holds it
-- exclusively. This index — not an application-level pre-check — is what makes
-- two simultaneous publishes of the same slug impossible (ADR-0013).
DROP INDEX IF EXISTS "invitations_slug_key";
CREATE UNIQUE INDEX "invitations_slug_live_key"
  ON "invitations" ("slug")
  WHERE "deleted_at" IS NULL AND "slug" IS NOT NULL;

-- ── Immutable published snapshots (ADR-0005) ───────────────────────────────
-- The domain returns deeply frozen objects and exposes no update method, but
-- neither survives contact with raw SQL. This trigger does: it is the layer
-- that actually guarantees a published snapshot cannot change under guests who
-- already hold the link.
--
-- DELETE is permitted only as part of cascading from the parent invitation, so
-- account deletion and retention still work.
CREATE OR REPLACE FUNCTION reject_invitation_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION
      'invitation_versions is immutable (ADR-0005): publish a new version instead of updating version % of invitation %',
      OLD.version_number, OLD.invitation_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (TG_OP = 'DELETE') THEN
    IF EXISTS (SELECT 1 FROM "invitations" WHERE "id" = OLD.invitation_id) THEN
      RAISE EXCEPTION
        'invitation_versions is immutable (ADR-0005): version % of invitation % cannot be deleted while the invitation exists',
        OLD.version_number, OLD.invitation_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invitation_versions_immutable
  BEFORE UPDATE OR DELETE ON "invitation_versions"
  FOR EACH ROW EXECUTE FUNCTION reject_invitation_version_mutation();

-- ── Append-only audit log ──────────────────────────────────────────────────
-- An audit log an operator can edit is not an audit log.
CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

-- ── Value constraints ──────────────────────────────────────────────────────
-- Enforced in the database as well as the domain: the domain protects the
-- application path, the database protects against everything else.

ALTER TABLE "rsvps"
  ADD CONSTRAINT "rsvps_party_size_range"
  CHECK ("party_size" >= 0 AND "party_size" <= 50);

ALTER TABLE "rsvps"
  ADD CONSTRAINT "rsvps_note_length"
  CHECK ("note" IS NULL OR length("note") <= 500);

ALTER TABLE "rsvps"
  ADD CONSTRAINT "rsvps_name_length"
  CHECK (length("name") BETWEEN 1 AND 80);

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_max_party_size_range"
  CHECK ("max_party_size" >= 0 AND "max_party_size" <= 50);

-- Slug shape, so a value that bypasses the domain still cannot produce an
-- ambiguous or hostile URL.
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_slug_shape"
  CHECK ("slug" IS NULL OR "slug" ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$');

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_draft_version_positive"
  CHECK ("draft_version" >= 1);

-- A published invitation must point at a snapshot; an unpublished one must not
-- claim to. This is the draft/published separation expressed as a constraint.
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_published_requires_version"
  CHECK ("status" <> 'PUBLISHED' OR "published_version_id" IS NOT NULL);

ALTER TABLE "invitation_versions"
  ADD CONSTRAINT "invitation_versions_number_positive"
  CHECK ("version_number" >= 1);

-- An override targets exactly one thing, and carries exactly one kind of value.
ALTER TABLE "entitlement_overrides"
  ADD CONSTRAINT "entitlement_overrides_target_exclusive"
  CHECK (
    (("feature" IS NOT NULL)::int + ("limit_key" IS NOT NULL)::int) = 1
    AND (("numeric_value" IS NOT NULL)::int + ("bool_value" IS NOT NULL)::int) = 1
  );

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_price_needs_currency"
  CHECK ("price_amount" IS NULL OR "currency" IS NOT NULL);

-- Money is stored in minor units and can never be negative.
ALTER TABLE "plans"
  ADD CONSTRAINT "plans_price_non_negative"
  CHECK ("price_amount" IS NULL OR "price_amount" >= 0);

ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_size_positive"
  CHECK ("size_bytes" > 0);

-- Market codes are ISO 3166-1 alpha-2 (ADR-0015).
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_market_code_shape"
  CHECK ("market_code" ~ '^[A-Z]{2}$');

ALTER TABLE "users"
  ADD CONSTRAINT "users_market_code_shape"
  CHECK ("market_code" ~ '^[A-Z]{2}$');
