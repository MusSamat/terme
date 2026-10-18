-- Driver / passenger mode is one per-user preference shared by web, mobile and
-- the Telegram bot (it only changes what the home screen leads with).
ALTER TABLE "users"
  ADD COLUMN "preferred_mode" VARCHAR(10) NOT NULL DEFAULT 'passenger',
  ADD CONSTRAINT "users_preferred_mode_check" CHECK ("preferred_mode" IN ('passenger', 'driver'));

-- Anyone who already owns a car or published a trip starts in driver mode.
UPDATE "users" u SET "preferred_mode" = 'driver'
 WHERE EXISTS (SELECT 1 FROM "cars" c WHERE c.user_id = u.id AND c.deleted_at IS NULL)
    OR 'driver' = ANY (u.roles);

-- One trip-preference key set (TripPreferences): legacy no_smoking → smoking=false,
-- silence → quiet. Search filters on smoking / animals / women_only.
UPDATE "trips"
   SET "preferences" = ("preferences" - 'no_smoking' - 'silence')
       || CASE WHEN ("preferences" ->> 'no_smoking')::boolean IS TRUE
               THEN '{"smoking": false}'::jsonb ELSE '{}'::jsonb END
       || CASE WHEN ("preferences" ->> 'silence') IS NOT NULL
               THEN jsonb_build_object('quiet', ("preferences" ->> 'silence')::boolean) ELSE '{}'::jsonb END
 WHERE "preferences" ?| ARRAY['no_smoking', 'silence'];
