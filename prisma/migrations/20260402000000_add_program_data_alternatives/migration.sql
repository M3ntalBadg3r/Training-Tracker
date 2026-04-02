-- CreateTable
CREATE TABLE "program_data_alternatives" (
    "id" SERIAL NOT NULL,
    "program_data_id" INTEGER NOT NULL,
    "training_type" "TrainingType" NOT NULL,
    "training_title" TEXT NOT NULL,

    CONSTRAINT "program_data_alternatives_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "program_data_alternatives" ADD CONSTRAINT "program_data_alternatives_program_data_id_fkey" FOREIGN KEY ("program_data_id") REFERENCES "program_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_data_alternatives" ADD CONSTRAINT "program_data_alternatives_training_title_fkey" FOREIGN KEY ("training_title") REFERENCES "training_data"("training_title") ON DELETE CASCADE ON UPDATE CASCADE;
