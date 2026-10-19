-- H4: refresh-token families for reuse detection.
-- Every existing token becomes its own family (family_id = id).
ALTER TABLE "refresh_tokens"
  ADD COLUMN "family_id"      UUID,
  ADD COLUMN "replaced_by_id" UUID;

UPDATE "refresh_tokens" SET "family_id" = "id" WHERE "family_id" IS NULL;

ALTER TABLE "refresh_tokens"
  ALTER COLUMN "family_id" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "family_id" SET NOT NULL;

CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens" ("family_id");
