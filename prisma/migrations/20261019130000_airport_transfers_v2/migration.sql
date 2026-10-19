-- Airport transfers v2: only «Манас» and Ош run transfers. The other airports
-- stay in the directory (admin can re-enable them in the cities admin); rides
-- that already reference them keep their FK and keep reading normally —
-- inactive places are only refused for NEW trips / requests.
UPDATE "cities" SET "is_active" = false
 WHERE "soate_code" IN ('airport:IKU', 'airport:JUL', 'airport:BAT');

-- Бишкек city districts may be the non-airport end of a transfer (GET
-- /cities?scope=any). SOATE gives them no point: approximate centroids,
-- flagged coord_approx so an admin can refine them.
UPDATE "cities" c SET "lat" = v.lat, "lng" = v.lng, "coord_approx" = true
  FROM (VALUES
    ('41711201000000', 42.8566, 74.5570),
    ('41711202000000', 42.8380, 74.6200),
    ('41711203000000', 42.8850, 74.5950),
    ('41711204000000', 42.8870, 74.6500)
  ) AS v(code, lat, lng)
 WHERE c."soate_code" = v.code AND c."lat" IS NULL;
