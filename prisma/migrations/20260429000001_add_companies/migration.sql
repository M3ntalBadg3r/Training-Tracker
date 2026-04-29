-- Promote any existing Admin users to SuperAdmin so today's behaviour is preserved.
UPDATE "users" SET "role" = 'SuperAdmin' WHERE "role" = 'Admin';

-- CreateTable: companies
CREATE TABLE "companies" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "companies_name_key" ON "companies"("name");

-- Seed default "Unassigned" company so existing rows can backfill cleanly.
INSERT INTO "companies" ("name", "updated_at") VALUES ('Unassigned', CURRENT_TIMESTAMP);

-- CreateTable: user_companies (many-to-many user <-> company)
CREATE TABLE "user_companies" (
    "user_id" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL,

    CONSTRAINT "user_companies_pkey" PRIMARY KEY ("user_id", "company_id")
);

CREATE INDEX "user_companies_company_id_idx" ON "user_companies"("company_id");

ALTER TABLE "user_companies"
    ADD CONSTRAINT "user_companies_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_companies"
    ADD CONSTRAINT "user_companies_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add company_id to students (nullable, backfill, then NOT NULL)
ALTER TABLE "students" ADD COLUMN "company_id" INTEGER;

UPDATE "students" SET "company_id" = (SELECT "id" FROM "companies" WHERE "name" = 'Unassigned');

ALTER TABLE "students" ALTER COLUMN "company_id" SET NOT NULL;

CREATE INDEX "students_company_id_idx" ON "students"("company_id");

ALTER TABLE "students"
    ADD CONSTRAINT "students_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add company_id to scheduled_exports
ALTER TABLE "scheduled_exports" ADD COLUMN "company_id" INTEGER;

UPDATE "scheduled_exports" SET "company_id" = (SELECT "id" FROM "companies" WHERE "name" = 'Unassigned');

ALTER TABLE "scheduled_exports" ALTER COLUMN "company_id" SET NOT NULL;

CREATE INDEX "scheduled_exports_company_id_idx" ON "scheduled_exports"("company_id");

ALTER TABLE "scheduled_exports"
    ADD CONSTRAINT "scheduled_exports_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
