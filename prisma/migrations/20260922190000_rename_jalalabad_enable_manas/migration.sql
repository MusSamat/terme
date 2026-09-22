-- «Джалал-Абад» → «Жалал-Абад» (the official Kyrgyz spelling) for the город.
-- Keep the old «Джалал» spelling as a search alias so users still find it.
UPDATE cities
SET name_ru = 'Жалал-Абад',
    prompt = (
      SELECT array_agg(DISTINCT x)
      FROM unnest(coalesce(prompt, '{}'::text[]) ||
                  ARRAY['джалал-абад','жалал-абад','jalal-abad','jalalabad','джалалабад']) AS x
    )
WHERE name_ru = 'Джалал-Абад' AND type = 'city';

-- Carry existing trips/requests over to the new spelling so they keep matching.
UPDATE trips SET origin_city = 'Жалал-Абад' WHERE origin_city = 'Джалал-Абад';
UPDATE trips SET destination_city = 'Жалал-Абад' WHERE destination_city = 'Джалал-Абад';
UPDATE passenger_requests SET origin_city = 'Жалал-Абад' WHERE origin_city = 'Джалал-Абад';
UPDATE passenger_requests SET destination_city = 'Жалал-Абад' WHERE destination_city = 'Джалал-Абад';

-- Make «Манас» (the город in Жалал-Абадская область) selectable as a destination.
UPDATE cities
SET is_searchable = true, is_active = true,
    prompt = (
      SELECT array_agg(DISTINCT x)
      FROM unnest(coalesce(prompt, '{}'::text[]) ||
                  ARRAY['манас','manas','манас шаары']) AS x
    )
WHERE name_ru = 'Манас' AND type = 'city' AND region_name_ru = 'Жалал-Абадская область';
