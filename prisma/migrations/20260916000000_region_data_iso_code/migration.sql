-- Add the ISO 3166-1 alpha-2 country code to region data. This is the join key
-- from a free-text country name to a geometry; without it a map match fails
-- silently ("UK" vs "United Kingdom") and under-reports rather than erroring.
--
-- Nullable, and NULL is a first-class "unmapped" state — reported in the admin
-- UI, never dropped or guessed at.
--
-- Deliberately NOT unique: two rows may legitimately share a code (a sales
-- geography carrying sub-national entries that all map to one country).
ALTER TABLE "region_data"
  ADD COLUMN "iso_code" VARCHAR(2);

-- Shape is enforced here as well as in the route handlers (defence in depth,
-- mirroring the product_types colour CHECK).
ALTER TABLE "region_data"
  ADD CONSTRAINT "region_data_iso_code_check"
  CHECK ("iso_code" IS NULL OR "iso_code" ~ '^[A-Z]{2}$');
