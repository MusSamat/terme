-- Presence / online tracking.
-- last_platform: origin of the most recent presence ping (web | mini | mobile).
-- Index on last_seen_at powers the "online now" COUNT(last_seen_at >= now-60s)
-- and the existing DAU/WAU/MAU queries (which read last_seen_at).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_platform" VARCHAR(10);

CREATE INDEX IF NOT EXISTS "users_last_seen_at_idx" ON "users" ("last_seen_at");
