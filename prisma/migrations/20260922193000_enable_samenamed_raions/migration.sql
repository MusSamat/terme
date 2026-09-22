-- Show the район next to the same-named город. Some oblast centers have a
-- district with the same name (е.g. «Баткен» город + «Баткен» район). Enable
-- ONLY those raions whose name matches a searchable город, so the user sees two
-- clearly-labelled variants («Баткен · город» / «Баткен · район») instead of a
-- missing/ambiguous entry. The client tags results by type. Oblasts stay hidden.
-- Idempotent: already-searchable rows are skipped.
UPDATE cities
SET is_searchable = true
WHERE type = 'raion'
  AND is_active = true
  AND is_searchable = false
  AND name_ru IN (
    SELECT name_ru FROM cities WHERE type = 'city' AND is_searchable = true
  );
