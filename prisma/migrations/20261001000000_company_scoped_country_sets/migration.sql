-- Company-scope Country Sets.
--
-- Country Sets become tenant data: each set belongs to exactly one Company and
-- names are unique per company. Sets created before this migration were
-- global — every company could report against them — so each one is COPIED
-- INTO EVERY COMPANY (with its members) rather than handed to one, which keeps
-- every company's view unchanged. The global originals are then removed. With
-- no companies at all, the originals are simply removed.
--
-- Written to be IDEMPOTENT / re-runnable (Prisma Migrate does not wrap a
-- migration in a transaction, so a failed attempt can leave earlier statements
-- committed): every step guards on the current state.

-- 1. Nullable company_id; NULL marks a pre-migration (global) set. ------------
ALTER TABLE "country_sets" ADD COLUMN IF NOT EXISTS "company_id" INTEGER;

-- 2. The global name index must go before same-named copies can exist. -------
DROP INDEX IF EXISTS "country_sets_name_key";

-- 3. Copy every global set into every company (skipping copies that already
--    exist from an earlier partial run). ---------------------------------------
INSERT INTO "country_sets" ("company_id", "name", "description", "created_at", "updated_at")
SELECT c."id", s."name", s."description", s."created_at", CURRENT_TIMESTAMP
FROM "country_sets" s
CROSS JOIN "companies" c
WHERE s."company_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "country_sets" x
    WHERE x."company_id" = c."id" AND x."name" = s."name"
  );

-- 4. Copy the members onto each company's copy. --------------------------------
INSERT INTO "country_set_members" ("country_set_id", "country")
SELECT copy."id", m."country"
FROM "country_set_members" m
JOIN "country_sets" orig ON orig."id" = m."country_set_id" AND orig."company_id" IS NULL
JOIN "country_sets" copy ON copy."name" = orig."name" AND copy."company_id" IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5. Drop the global originals (their members cascade). ------------------------
DELETE FROM "country_sets" WHERE "company_id" IS NULL;

ALTER TABLE "country_sets" ALTER COLUMN "company_id" SET NOT NULL;

-- 6. Per-company uniqueness, lookup index and the company FK. -----------------
CREATE UNIQUE INDEX IF NOT EXISTS "country_sets_company_id_name_key" ON "country_sets"("company_id", "name");
CREATE INDEX IF NOT EXISTS "country_sets_company_id_idx" ON "country_sets"("company_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'country_sets_company_id_fkey'
  ) THEN
    -- Cascade: a set only describes its own company's geography, and RESTRICT
    -- would add another blocker to deleting a company.
    ALTER TABLE "country_sets" ADD CONSTRAINT "country_sets_company_id_fkey"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
