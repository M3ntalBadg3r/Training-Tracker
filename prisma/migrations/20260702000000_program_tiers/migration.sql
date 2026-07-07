-- AlterTable: programs gain tier configuration
ALTER TABLE "programs" ADD COLUMN "is_tiered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "programs" ADD COLUMN "deployment_mode" TEXT NOT NULL DEFAULT 'flat';

-- CreateTable: ordered tiers per program
CREATE TABLE "program_tiers" (
    "id" SERIAL NOT NULL,
    "program_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "specialisations_required" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "program_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "program_tiers_program_name_name_key" ON "program_tiers"("program_name", "name");

-- AlterTable: program_data can belong to a tier instead of a specialisation
ALTER TABLE "program_data" ALTER COLUMN "specialisation_id" DROP NOT NULL;
ALTER TABLE "program_data" ADD COLUMN "tier_id" INTEGER;
ALTER TABLE "program_data" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'qualification';

-- AddForeignKey
ALTER TABLE "program_tiers" ADD CONSTRAINT "program_tiers_program_name_fkey" FOREIGN KEY ("program_name") REFERENCES "programs"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_data" ADD CONSTRAINT "program_data_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "program_tiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
