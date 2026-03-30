-- CreateEnum
CREATE TYPE "ProgramLevel" AS ENUM ('Country', 'Theatre', 'Global');

-- CreateTable
CREATE TABLE "specialisations" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "specialisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_data" (
    "id" SERIAL NOT NULL,
    "program_name" TEXT NOT NULL,
    "specialisation_id" INTEGER NOT NULL,
    "level" "ProgramLevel" NOT NULL,
    "training_type" "TrainingType" NOT NULL,
    "training_title" TEXT NOT NULL,
    "quantity_required" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "program_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "specialisations_name_key" ON "specialisations"("name");

-- AddForeignKey
ALTER TABLE "program_data" ADD CONSTRAINT "program_data_specialisation_id_fkey" FOREIGN KEY ("specialisation_id") REFERENCES "specialisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_data" ADD CONSTRAINT "program_data_training_title_fkey" FOREIGN KEY ("training_title") REFERENCES "training_data"("training_title") ON DELETE CASCADE ON UPDATE CASCADE;
