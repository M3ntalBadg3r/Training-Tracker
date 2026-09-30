-- ProgramData.aggregation: how a multi-country level counts a requirement.
ALTER TABLE "program_data" ADD COLUMN "aggregation" TEXT NOT NULL DEFAULT 'total';
ALTER TABLE "program_data" ADD CONSTRAINT "program_data_aggregation_check"
  CHECK ("aggregation" IN ('total', 'eachCountry'));
-- "eachCountry" only means something for a level spanning several countries.
ALTER TABLE "program_data" ADD CONSTRAINT "program_data_aggregation_level_check"
  CHECK ("aggregation" = 'total' OR "level" IN ('Region', 'CountrySet'));

-- CreateTable: country_sets (custom groupings of countries)
CREATE TABLE "country_sets" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "country_sets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "country_sets_name_key" ON "country_sets"("name");

-- CreateTable: country_set_members (set <-> country, many-to-many)
CREATE TABLE "country_set_members" (
    "country_set_id" INTEGER NOT NULL,
    "country" TEXT NOT NULL,

    CONSTRAINT "country_set_members_pkey" PRIMARY KEY ("country_set_id", "country")
);

CREATE INDEX "country_set_members_country_idx" ON "country_set_members"("country");

ALTER TABLE "country_set_members" ADD CONSTRAINT "country_set_members_country_set_id_fkey"
  FOREIGN KEY ("country_set_id") REFERENCES "country_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ON UPDATE CASCADE: a Region Data country rename carries memberships along.
-- ON DELETE CASCADE: deleting a country removes it from every set.
ALTER TABLE "country_set_members" ADD CONSTRAINT "country_set_members_country_fkey"
  FOREIGN KEY ("country") REFERENCES "region_data"("country") ON DELETE CASCADE ON UPDATE CASCADE;
