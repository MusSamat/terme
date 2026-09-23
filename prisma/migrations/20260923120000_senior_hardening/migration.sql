-- Senior hardening pass: sanction persistence, price snapshot, completed_at,
-- hot-path indexes, and an idempotency guard against double loyalty awards.

-- ── New columns ──────────────────────────────────────────────────────────
-- Accumulated behavioural penalties, subtracted in recalcAverage so driver-cancel
-- / no-show sanctions survive subsequent ratings (previously overwritten).
ALTER TABLE "users" ADD COLUMN "rating_penalty" DECIMAL(4,2) NOT NULL DEFAULT 0.00;

-- Terminal-completion timestamp — drives the 48h phone-visibility window,
-- decoupled from updated_at (which view/like increments kept bumping).
ALTER TABLE "trips" ADD COLUMN "completed_at" TIMESTAMPTZ(6);

-- Backfill: existing completed trips get their completion approximated by
-- updated_at so their phone windows don't reopen indefinitely.
UPDATE "trips" SET "completed_at" = "updated_at" WHERE "status" = 'completed';

-- Price frozen at booking time so a post-acceptance trip price change can't
-- silently alter what the passenger agreed to pay.
ALTER TABLE "bookings" ADD COLUMN "price_per_seat_snapshot" INTEGER;

-- ── Hot-path indexes ─────────────────────────────────────────────────────
-- Reveal-count queries hit (context_type, context_id); viewer-led indexes miss them.
CREATE INDEX "contact_reveals_context_type_context_id_idx"
    ON "contact_reveals" ("context_type", "context_id");

-- Rating spam guard counts by rater_id (+comment); rater_id must lead.
CREATE INDEX "ratings_rater_id_idx" ON "ratings" ("rater_id");

-- ── Loyalty idempotency ──────────────────────────────────────────────────
-- Drop any pre-existing duplicate per-trip awards (keep the earliest row) before
-- the UNIQUE, so the constraint can be created on dirty prod data.
DELETE FROM "loyalty_transactions" a
USING "loyalty_transactions" b
WHERE a."trip_id" IS NOT NULL
  AND a."user_id" = b."user_id"
  AND a."trip_id" = b."trip_id"
  AND a."source"  = b."source"
  AND a."created_at" > b."created_at";

-- NULL trip_id (bonus/manual) stays exempt — Postgres treats NULLs as distinct.
CREATE UNIQUE INDEX "loyalty_transactions_user_id_trip_id_source_key"
    ON "loyalty_transactions" ("user_id", "trip_id", "source");

-- ── Expire-sweep partial index ───────────────────────────────────────────
-- The per-minute expireBookings cron scans WHERE status IN (pending,viewed)
-- AND expires_at < now(). A partial index keeps that sweep cheap forever.
CREATE INDEX IF NOT EXISTS "idx_bookings_expiry_sweep"
    ON "bookings" ("expires_at")
    WHERE "status" IN ('pending', 'viewed');

-- ── Booking active-dedup now also covers 'viewed' ────────────────────────
-- A viewed-but-unaccepted request should block a second concurrent booking on
-- the same trip, same as pending/accepted.
DROP INDEX IF EXISTS "idx_bookings_trip_passenger_active";
CREATE UNIQUE INDEX "idx_bookings_trip_passenger_active"
    ON "bookings" ("trip_id", "passenger_id")
    WHERE "status" IN ('pending', 'viewed', 'accepted');
