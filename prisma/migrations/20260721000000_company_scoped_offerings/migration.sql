-- Company-scope Offerings.
--
-- Offerings become tenant data: each Offering belongs to exactly one Company,
-- names are unique per-company (not globally), and the child join tables
-- reference the immutable numeric offering id instead of the (no-longer-unique)
-- offering name. Existing offerings are backfilled to the oldest company (the
-- lowest companies.id); if no company exists they are removed (children cascade
-- via the existing name FKs, which are dropped only afterwards).
--
-- Ordering note: the child name FKs depend on the offerings(name) unique index
-- (offerings_name_key), so they MUST be dropped before that index — and the
-- children must be backfilled while offering_name still exists.

-- 1. Offering.company_id -----------------------------------------------------
ALTER TABLE "offerings" ADD COLUMN "company_id" INTEGER;

UPDATE "offerings" SET "company_id" = (SELECT MIN("id") FROM "companies");

-- Only fires when there are zero companies (MIN(...) IS NULL). Such offerings
-- are unusable; their specialisation/requirement children cascade away through
-- the ON DELETE CASCADE name FKs that are still in place at this point.
DELETE FROM "offerings" WHERE "company_id" IS NULL;

ALTER TABLE "offerings" ALTER COLUMN "company_id" SET NOT NULL;

-- 2. Backfill children's offering_id (while offering_name + its FKs still exist)
ALTER TABLE "offering_specialisations" ADD COLUMN "offering_id" INTEGER;
UPDATE "offering_specialisations" os
SET "offering_id" = o."id"
FROM "offerings" o
WHERE os."offering_name" = o."name";

ALTER TABLE "offering_data" ADD COLUMN "offering_id" INTEGER;
UPDATE "offering_data" od
SET "offering_id" = o."id"
FROM "offerings" o
WHERE od."offering_name" = o."name";

-- 3. Drop the child name FKs FIRST — they depend on offerings_name_key.
ALTER TABLE "offering_specialisations" DROP CONSTRAINT "offering_specialisations_offering_name_fkey";
ALTER TABLE "offering_data" DROP CONSTRAINT "offering_data_offering_name_fkey";

-- 4. Now the name unique index has no dependents: swap it for (company_id, name)
--    and add the company FK.
DROP INDEX "offerings_name_key";
CREATE UNIQUE INDEX "offerings_company_id_name_key" ON "offerings"("company_id", "name");
CREATE INDEX "offerings_company_id_idx" ON "offerings"("company_id");
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Finish offering_specialisations: drop the old PK + name column, then rebuild
--    the PK/FK on offering_id.
ALTER TABLE "offering_specialisations" DROP CONSTRAINT "offering_specialisations_pkey";
ALTER TABLE "offering_specialisations" DROP COLUMN "offering_name";
ALTER TABLE "offering_specialisations" ALTER COLUMN "offering_id" SET NOT NULL;
ALTER TABLE "offering_specialisations" ADD CONSTRAINT "offering_specialisations_pkey" PRIMARY KEY ("offering_id", "specialisation_id");
ALTER TABLE "offering_specialisations" ADD CONSTRAINT "offering_specialisations_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Finish offering_data: drop the old index + name column, then rebuild the
--    index/FK on offering_id.
DROP INDEX "offering_data_offering_name_idx";
ALTER TABLE "offering_data" DROP COLUMN "offering_name";
ALTER TABLE "offering_data" ALTER COLUMN "offering_id" SET NOT NULL;
CREATE INDEX "offering_data_offering_id_idx" ON "offering_data"("offering_id");
ALTER TABLE "offering_data" ADD CONSTRAINT "offering_data_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
