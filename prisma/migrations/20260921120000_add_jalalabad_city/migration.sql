-- Jalal-Abad (3rd-largest KG city) was missing from the cities directory — only
-- the oblast «Жалал-Абадская область» existed. Trip create/search validates
-- from_city/to_city by EXACT name_ru against cities, so any «Джалал-Абад» route
-- failed with unknown_city ("город не поддерживается"). Add the city.
--
-- name_ru uses the Russian spelling «Джалал-Абад» (Д) the app/SEO/seeds use;
-- name_kg the official «Жалал-Абад» (Ж). prompt carries both spellings + latin
-- + no-hyphen so search/autocomplete match regardless of how it's typed.
-- Idempotent: no-op if the city already exists.
INSERT INTO cities (name_ru, name_kg, type, region_name_ru, region_name_kg, lat, lng, prompt, priority, is_active, is_searchable)
SELECT 'Джалал-Абад', 'Жалал-Абад', 'city', 'Жалал-Абадская область', 'Жалал-Абад облусу',
       40.9333, 72.9861,
       ARRAY['джалал-абад', 'жалал-абад', 'jalal-abad', 'jalalabad', 'джалалабад'],
       100, true, true
WHERE NOT EXISTS (SELECT 1 FROM cities WHERE name_ru = 'Джалал-Абад');
