-- Target countries become part of the Theatre view, and minimums go per view.
--
-- Replaces the "anchored program" mode of 20261015000000_anchored_programs,
-- which made a whole program answer one combined view and nothing else. Now
-- any program may carry TargetCountries rows, evaluated in its By Theatre view
-- over the partner's target countries inside whichever theatre is viewed, and
-- keeps every other view. Minimums are held per view:
--   programs.country_set_minimum_countries / .target_minimum_countries
--   program_company_settings.country_set_minimum_countries / .country_set_id
--   program_company_settings.target_minimum_countries / .target_country_set_id
--
-- Existing anchored programs are converted: their CountrySet rows (which meant
-- "the partner's target countries") become TargetCountries rows, their default
-- minimum becomes the Theatre-view minimum, and each partner setting's minimum
-- and set become its Theatre-view terms. The anchor theatre itself is dropped —
-- target countries now apply in whichever theatre is viewed.
--
-- Re-runnable (Prisma Migrate does not wrap a migration in a transaction):
-- every step guards on the current state, and on a database that never had
-- anchored data the conversion matches nothing.

-- 1. Allow "eachCountry" on the new level (needed before converting rows).
ALTER TABLE "program_data" DROP CONSTRAINT IF EXISTS "program_data_aggregation_level_check";
ALTER TABLE "program_data" ADD CONSTRAINT "program_data_aggregation_level_check"
  CHECK ("aggregation" = 'total' OR "level" IN ('Region', 'CountrySet', 'TargetCountries'));

-- 2. Convert anchored programs, then drop the anchor.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'programs' AND column_name = 'anchor_theatre') THEN
    UPDATE "program_data" pd
       SET "level" = 'TargetCountries'
      FROM "programs" p
     WHERE p."name" = pd."program_name"
       AND p."anchor_theatre" IS NOT NULL
       AND btrim(p."anchor_theatre") <> ''
       AND pd."level" = 'CountrySet';
    ALTER TABLE "programs" DROP COLUMN "anchor_theatre";
  END IF;
END $$;

-- 3. programs: the default minimum becomes the Theatre-view one; add the
--    Country Set-view one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'programs' AND column_name = 'default_minimum_countries')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'programs' AND column_name = 'target_minimum_countries') THEN
    ALTER TABLE "programs" RENAME COLUMN "default_minimum_countries" TO "target_minimum_countries";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'programs_default_minimum_countries_check') THEN
    ALTER TABLE "programs" RENAME CONSTRAINT "programs_default_minimum_countries_check" TO "programs_target_minimum_countries_check";
  END IF;
END $$;

ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "target_minimum_countries" INTEGER;
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "country_set_minimum_countries" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'programs_target_minimum_countries_check') THEN
    ALTER TABLE "programs" ADD CONSTRAINT "programs_target_minimum_countries_check"
      CHECK ("target_minimum_countries" IS NULL OR "target_minimum_countries" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'programs_country_set_minimum_countries_check') THEN
    ALTER TABLE "programs" ADD CONSTRAINT "programs_country_set_minimum_countries_check"
      CHECK ("country_set_minimum_countries" IS NULL OR "country_set_minimum_countries" >= 1);
  END IF;
END $$;

-- 4. program_company_settings: the existing minimum and set become the
--    Theatre-view terms; add the Country Set-view pair.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'program_company_settings' AND column_name = 'minimum_countries')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'program_company_settings' AND column_name = 'target_minimum_countries') THEN
    ALTER TABLE "program_company_settings" RENAME COLUMN "minimum_countries" TO "target_minimum_countries";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_company_settings_minimum_countries_check') THEN
    ALTER TABLE "program_company_settings" RENAME CONSTRAINT "program_company_settings_minimum_countries_check"
      TO "program_company_settings_target_minimum_countries_check";
  END IF;
END $$;

ALTER TABLE "program_company_settings" ADD COLUMN IF NOT EXISTS "target_minimum_countries" INTEGER;
ALTER TABLE "program_company_settings" ADD COLUMN IF NOT EXISTS "country_set_minimum_countries" INTEGER;
ALTER TABLE "program_company_settings" ADD COLUMN IF NOT EXISTS "country_set_id" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_company_settings_target_minimum_countries_check') THEN
    ALTER TABLE "program_company_settings" ADD CONSTRAINT "program_company_settings_target_minimum_countries_check"
      CHECK ("target_minimum_countries" IS NULL OR "target_minimum_countries" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_company_settings_country_set_minimum_countries_check') THEN
    ALTER TABLE "program_company_settings" ADD CONSTRAINT "program_company_settings_country_set_minimum_countries_check"
      CHECK ("country_set_minimum_countries" IS NULL OR "country_set_minimum_countries" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_company_settings_country_set_id_fkey') THEN
    -- SET NULL: deleting the set leaves the partner's minimum in place.
    ALTER TABLE "program_company_settings" ADD CONSTRAINT "program_company_settings_country_set_id_fkey"
      FOREIGN KEY ("country_set_id") REFERENCES "country_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
