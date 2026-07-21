-- Company-scope Offerings.
--
-- Offerings become tenant data: each Offering belongs to exactly one Company,
-- names are unique per-company (not globally), and the child join tables
-- reference the immutable numeric offering id instead of the (no-longer-unique)
-- offering name. Existing offerings are backfilled to the oldest company (the
-- lowest companies.id); if no company exists they are removed (children cascade
-- via the existing name FKs, which are dropped only afterwards).
--
-- This migration is written to be IDEMPOTENT / re-runnable. Prisma Migrate does
-- not wrap a migration in a transaction, so an earlier failed attempt can leave
-- some statements committed. Every step therefore guards on the current state
-- (IF [NOT] EXISTS / catalog checks) so it completes cleanly whether the target
-- is fresh or partially migrated. Ordering note: the child name FKs depend on
-- the offerings(name) unique index, so they are dropped before that index, and
-- children are backfilled while offering_name still exists.

-- 1. Offering.company_id -----------------------------------------------------
ALTER TABLE "offerings" ADD COLUMN IF NOT EXISTS "company_id" INTEGER;

UPDATE "offerings" SET "company_id" = (SELECT MIN("id") FROM "companies") WHERE "company_id" IS NULL;

-- Only removes rows when there are zero companies (backfill left them NULL).
DELETE FROM "offerings" WHERE "company_id" IS NULL;

ALTER TABLE "offerings" ALTER COLUMN "company_id" SET NOT NULL;

-- 2. Child offering_id columns + backfill (while offering_name still exists) ---
ALTER TABLE "offering_specialisations" ADD COLUMN IF NOT EXISTS "offering_id" INTEGER;
ALTER TABLE "offering_data" ADD COLUMN IF NOT EXISTS "offering_id" INTEGER;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'offering_specialisations' AND column_name = 'offering_name'
  ) THEN
    UPDATE "offering_specialisations" os
    SET "offering_id" = o."id"
    FROM "offerings" o
    WHERE os."offering_name" = o."name" AND os."offering_id" IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'offering_data' AND column_name = 'offering_name'
  ) THEN
    UPDATE "offering_data" od
    SET "offering_id" = o."id"
    FROM "offerings" o
    WHERE od."offering_name" = o."name" AND od."offering_id" IS NULL;
  END IF;
END $$;

-- 3. Drop the child name FKs FIRST — they depend on offerings_name_key. --------
ALTER TABLE "offering_specialisations" DROP CONSTRAINT IF EXISTS "offering_specialisations_offering_name_fkey";
ALTER TABLE "offering_data" DROP CONSTRAINT IF EXISTS "offering_data_offering_name_fkey";

-- 4. Swap the name unique index for (company_id, name) + add the company FK. ---
DROP INDEX IF EXISTS "offerings_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "offerings_company_id_name_key" ON "offerings"("company_id", "name");
CREATE INDEX IF NOT EXISTS "offerings_company_id_idx" ON "offerings"("company_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offerings_company_id_fkey' AND conrelid = 'offerings'::regclass) THEN
    ALTER TABLE "offerings" ADD CONSTRAINT "offerings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 5. Finish offering_specialisations: rebuild PK/FK on offering_id. ------------
ALTER TABLE "offering_specialisations" DROP CONSTRAINT IF EXISTS "offering_specialisations_pkey";
ALTER TABLE "offering_specialisations" DROP COLUMN IF EXISTS "offering_name";
ALTER TABLE "offering_specialisations" ALTER COLUMN "offering_id" SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offering_specialisations_pkey' AND conrelid = 'offering_specialisations'::regclass) THEN
    ALTER TABLE "offering_specialisations" ADD CONSTRAINT "offering_specialisations_pkey" PRIMARY KEY ("offering_id", "specialisation_id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offering_specialisations_offering_id_fkey' AND conrelid = 'offering_specialisations'::regclass) THEN
    ALTER TABLE "offering_specialisations" ADD CONSTRAINT "offering_specialisations_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 6. Finish offering_data: rebuild index/FK on offering_id. --------------------
DROP INDEX IF EXISTS "offering_data_offering_name_idx";
ALTER TABLE "offering_data" DROP COLUMN IF EXISTS "offering_name";
ALTER TABLE "offering_data" ALTER COLUMN "offering_id" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "offering_data_offering_id_idx" ON "offering_data"("offering_id");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offering_data_offering_id_fkey' AND conrelid = 'offering_data'::regclass) THEN
    ALTER TABLE "offering_data" ADD CONSTRAINT "offering_data_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
