-- H2: admin TOTP enrolment, secrets encrypted at rest, replay guard.
-- M6: per-admin token epoch for revoking stateless admin refresh JWTs.
--
-- Existing plaintext admins.totp_secret values (if any) cannot be encrypted
-- here — the key (TOTP_ENC_KEY) lives in the app env, not in the database.
-- They are migrated lazily: the next successful TOTP login encrypts the secret
-- into totp_secret_enc and nulls totp_secret (see auth.admin.ts).
ALTER TABLE "admins"
  ADD COLUMN "totp_secret_enc"  VARCHAR(300),
  ADD COLUMN "totp_pending_enc" VARCHAR(300),
  ADD COLUMN "totp_last_step"   INTEGER,
  ADD COLUMN "token_epoch"      INTEGER NOT NULL DEFAULT 0;
