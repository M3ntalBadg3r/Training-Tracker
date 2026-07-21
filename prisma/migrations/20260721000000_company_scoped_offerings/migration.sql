-- Company-scope Offerings.
--
-- Offerings become tenant data: each Offering belongs to exactly one Company,
-- names are unique per-company (not globally), and the child join tables
-- reference the immutable numeric offering id instead of the (no-longer-unique)
-- offering name. Existing offerings are backfilled to the oldest company (the
-- lowest companies.id); if no company exists they are removed (children cascade
-- via the existing name FKs, which are dropped only afterwards).

-- 1. Offering.company_id -----------------------------------------------------
ALTER TABLE "offerings" ADD COLUMN "company_id" INTEGER;

UPDATE "offerings" SET "company_id" = (SELECT MIN("id") FROM "companies");

-- Only fires when there are zero companies (MIN(...) IS NULL). Such offerings
-- are unusable; their specialisation/requirement children cascade away through
-- the ON DELETE CASCADE name FKs that are still in place at this point.
DELETE FROM "offerings" WHERE "company_id" IS NULL;

ALTER TABLE "offerings" ALTER COLUMN "company_id" SET NOT NULL;

-- Swap the global-unique name for a per-company-unique (company_id, name).
DROP INDEX "offerings_name_key";
CREATE UNIQUE INDEX "offerings_company_id_name_key" ON "offerings"("company_id", "name");
CREATE INDEX "offerings_company_id_idx" ON "offerings"("company_id");

ALTER TABLE "offerings" ADD CONSTRAINT "offerings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. offering_specialisations.offering_id ------------------------------------
ALTER TABLE "offering_specialisations" ADD COLUMN "offering_id" INTEGER;

UPDATE "offering_specialisations" os
SET "offering_id" = o."id"
FROM "offerings" o
WHERE os."offering_name" = o."name";

-- Drop the old name FK + composite PK, then the name column.
ALTER TABLE "offering_specialisations" DROP CONSTRAINT "offering_specialisations_offering_name_fkey";
ALTER TABLE "offering_specialisations" DROP CONSTRAINT "offering_specialisations_pkey";
ALTER TABLE "offering_specialisations" DROP COLUMN "offering_name";

ALTER TABLE "offering_specialisations" ALTER COLUMN "offering_id" SET NOT NULL;
ALTER TABLE "offering_specialisations" ADD CONSTRAINT "offering_specialisations_pkey" PRIMARY KEY ("offering_id", "specialisation_id");
ALTER TABLE "offering_specialisations" ADD CONSTRAINT "offering_specialisations_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. offering_data.offering_id -----------------------------------------------
ALTER TABLE "offering_data" ADD COLUMN "offering_id" INTEGER;

UPDATE "offering_data" od
SET "offering_id" = o."id"
FROM "offerings" o
WHERE od."offering_name" = o."name";

ALTER TABLE "offering_data" DROP CONSTRAINT "offering_data_offering_name_fkey";
DROP INDEX "offering_data_offering_name_idx";
ALTER TABLE "offering_data" DROP COLUMN "offering_name";

ALTER TABLE "offering_data" ALTER COLUMN "offering_id" SET NOT NULL;
CREATE INDEX "offering_data_offering_id_idx" ON "offering_data"("offering_id");
ALTER TABLE "offering_data" ADD CONSTRAINT "offering_data_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
