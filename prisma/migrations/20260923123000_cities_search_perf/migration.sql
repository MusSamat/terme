-- Cities autocomplete: trigram indexes for substring search.
--
-- The public GET /cities?q= autocomplete filters cities with expressions that
-- no B-tree index can serve, so every keystroke did a full sequential scan:
--   translate(lower(name_ru), 'ёөүң','еоун') LIKE '%..%'   (RU/KG fold)
--   translate(lower(name_kg), 'ёөүң','еоун') LIKE '%..%'
--   name_en ILIKE '%..%'
--   EXISTS(unnest(prompt) p WHERE translate(lower(p),'ёөүң','еоун') LIKE '%..%')
--
-- Fix: pg_trgm GIN indexes on precomputed, folded columns that EXACTLY match
-- the query's filter expressions, so the planner uses them for the substring
-- (LIKE '%..%') predicates. Results are unchanged — only made index-backed.
--
-- pg_trgm: substring/ILIKE acceleration via 3-gram GIN.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Immutable fold helper for the prompt text[] array: lower + RU/KG fold each
-- element, join with space. Space-joined because prompt elements are single
-- city-name tokens («jalalabad», «жалал-абад») — a substring query for one city
-- never legitimately spans two elements, so joined-vs-unnest results match.
CREATE OR REPLACE FUNCTION cities_prompt_folded(text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT translate(lower(array_to_string($1, ' ')), 'ёөүң', 'еоун')
$$;

-- Generated, folded columns matching each query expression verbatim.
--   name_ru_folded / name_kg_folded  ← translate(lower(name_*),'ёөүң','еоун')
--   name_en_lower                    ← lower(name_en)   (ILIKE → LIKE lower())
--   prompt_folded                    ← cities_prompt_folded(prompt)
ALTER TABLE "cities"
  ADD COLUMN IF NOT EXISTS "name_ru_folded" text
    GENERATED ALWAYS AS (translate(lower("name_ru"), 'ёөүң', 'еоун')) STORED,
  ADD COLUMN IF NOT EXISTS "name_kg_folded" text
    GENERATED ALWAYS AS (translate(lower("name_kg"), 'ёөүң', 'еоун')) STORED,
  ADD COLUMN IF NOT EXISTS "name_en_lower" text
    GENERATED ALWAYS AS (lower("name_en")) STORED,
  ADD COLUMN IF NOT EXISTS "prompt_folded" text
    GENERATED ALWAYS AS (cities_prompt_folded("prompt")) STORED;

-- GIN trigram indexes — the planner uses these for LIKE '%..%' on each column.
CREATE INDEX IF NOT EXISTS "cities_name_ru_folded_trgm_idx"
  ON "cities" USING gin ("name_ru_folded" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "cities_name_kg_folded_trgm_idx"
  ON "cities" USING gin ("name_kg_folded" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "cities_name_en_lower_trgm_idx"
  ON "cities" USING gin ("name_en_lower" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "cities_prompt_folded_trgm_idx"
  ON "cities" USING gin ("prompt_folded" gin_trgm_ops);
