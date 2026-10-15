-- Anchored programs and per-partner program settings.
--
-- An anchored program is judged over two populations in one view: its
-- Theatre-level rows over `programs.anchor_theatre`, and its CountrySet-level
-- rows over the partner's own target Country Set. Each partner (company) may
-- carry its own terms for a program in `program_company_settings`: the minimum
-- number of target countries it must name, and which of its sets holds them.
--
-- Written to be re-runnable (Prisma Migrate does not wrap a migration in a
-- transaction): every step guards on the current state. Purely additive —
-- existing programs keep NULL anchor settings and behave exactly as before.

ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "anchor_theatre" TEXT;
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "default_minimum_countries" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'programs_default_minimum_countries_check') THEN
    ALTER TABLE "programs" ADD CONSTRAINT "programs_default_minimum_countries_check"
      CHECK ("default_minimum_countries" IS NULL OR "default_minimum_countries" >= 1);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "program_company_settings" (
    "id" SERIAL NOT NULL,
    "program_id" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL,
    "minimum_countries" INTEGER,
    "target_country_set_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "program_company_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "program_company_settings_program_id_company_id_key"
  ON "program_company_settings"("program_id", "company_id");
CREATE INDEX IF NOT EXISTS "program_company_settings_company_id_idx"
  ON "program_company_settings"("company_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_company_settings_minimum_countries_check') THEN
    ALTER TABLE "program_company_settings" ADD CONSTRAINT "program_company_settings_minimum_countries_check"
      CHECK ("minimum_countries" IS NULL OR "minimum_countries" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_company_settings_program_id_fkey') THEN
    ALTER TABLE "program_company_settings" ADD CONSTRAINT "program_company_settings_program_id_fkey"
      FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_company_settings_company_id_fkey') THEN
    -- Cascade: a partner's terms mean nothing without the partner.
    ALTER TABLE "program_company_settings" ADD CONSTRAINT "program_company_settings_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'program_company_settings_target_country_set_id_fkey') THEN
    -- SET NULL: deleting the set leaves the partner's minimum in place.
    ALTER TABLE "program_company_settings" ADD CONSTRAINT "program_company_settings_target_country_set_id_fkey"
      FOREIGN KEY ("target_country_set_id") REFERENCES "country_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
