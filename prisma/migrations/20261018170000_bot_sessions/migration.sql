-- Telegram bot conversation state (multi-step flows: search, publish, …).
-- One row per Telegram chat; survives restarts and multiple instances.
CREATE TABLE "bot_sessions" (
  "telegram_id" BIGINT PRIMARY KEY,
  "state"       VARCHAR(40),
  "data"        JSONB NOT NULL DEFAULT '{}',
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "bot_sessions_updated_at_idx" ON "bot_sessions" ("updated_at");
