-- Homonym cleanup. Some settlements are listed 2–3× with the SAME name AND the
-- same район AND the same айыл (duplicate imports). The client shows «район,
-- айыл» as the subtitle, so these rows are indistinguishable to the user.
--
-- Keep one row per (name_ru, район, айыл) group — highest priority, then lowest
-- id — and hide the rest from search (is_searchable = false). Settlements that
-- share a name but differ by район/айыл are NOT touched: their subtitles already
-- tell them apart. Oblasts/raions are excluded from search elsewhere.
--
-- Idempotent: once the extras are hidden, the CTE (which only looks at
-- is_searchable = true rows) no longer sees them, so re-running is a no-op.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY name_ru,
                        coalesce(district_name_ru, ''),
                        coalesce(aiyl_aimak_name_ru, '')
           ORDER BY priority DESC, id ASC
         ) AS rn
  FROM cities
  WHERE is_active = true
    AND is_searchable = true
    AND type NOT IN ('oblast', 'raion')
)
UPDATE cities
SET is_searchable = false
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
