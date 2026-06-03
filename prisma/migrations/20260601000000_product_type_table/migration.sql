-- Convert the ProductType enum into a data-driven table.
-- Data-preserving: seed existing values, backfill the FK, then drop the old
-- column and enum type. Idempotent seeding so re-runs are safe.

-- 1. New table
CREATE TABLE "product_types" (
    "id"   SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "product_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "product_types_name_key" ON "product_types"("name");

-- 2. Seed only from values actually present in the legacy enum column.
--    Fresh installs have an empty training_data, so no product types are
--    created here — the catalogue starts empty and types are added on demand
--    (lib/product-types.ts:ensureDefaultProductTypeId) or via the admin UI.
INSERT INTO "product_types" ("name")
SELECT DISTINCT "product_type"::text FROM "training_data"
ON CONFLICT ("name") DO NOTHING;

-- 3. Add nullable FK column.
ALTER TABLE "training_data" ADD COLUMN "product_type_id" INTEGER;

-- 4. Backfill by matching the old enum text to the new table name.
UPDATE "training_data" td
SET "product_type_id" = pt."id"
FROM "product_types" pt
WHERE pt."name" = td."product_type"::text;

-- 5. Enforce NOT NULL + FK now that every row is backfilled.
ALTER TABLE "training_data" ALTER COLUMN "product_type_id" SET NOT NULL;
ALTER TABLE "training_data"
    ADD CONSTRAINT "training_data_product_type_id_fkey"
    FOREIGN KEY ("product_type_id") REFERENCES "product_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "training_data_product_type_id_idx" ON "training_data"("product_type_id");

-- 6. Drop the old enum column and the now-unused type.
ALTER TABLE "training_data" DROP COLUMN "product_type";
DROP TYPE "ProductType";
