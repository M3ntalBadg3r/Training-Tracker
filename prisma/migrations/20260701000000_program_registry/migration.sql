-- CreateTable
CREATE TABLE "programs" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "programs_name_key" ON "programs"("name");

-- Backfill the registry from existing program_data so current programs still show as boxes
INSERT INTO "programs" ("name")
  SELECT DISTINCT "program_name" FROM "program_data"
  ON CONFLICT ("name") DO NOTHING;
