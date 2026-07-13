-- CreateTable
CREATE TABLE "offerings" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "link" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offerings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offerings_name_key" ON "offerings"("name");

-- CreateTable
CREATE TABLE "offering_specialisations" (
    "offering_name" TEXT NOT NULL,
    "specialisation_id" INTEGER NOT NULL,

    CONSTRAINT "offering_specialisations_pkey" PRIMARY KEY ("offering_name", "specialisation_id")
);

-- CreateTable
CREATE TABLE "offering_data" (
    "id" SERIAL NOT NULL,
    "offering_name" TEXT NOT NULL,
    "specialisation_id" INTEGER NOT NULL,
    "training_type" "TrainingType",
    "training_title" TEXT,
    "quantity_required" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offering_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offering_data_offering_name_idx" ON "offering_data"("offering_name");

-- CreateTable
CREATE TABLE "offering_data_alternatives" (
    "id" SERIAL NOT NULL,
    "offering_data_id" INTEGER NOT NULL,
    "training_type" "TrainingType" NOT NULL,
    "training_title" TEXT NOT NULL,

    CONSTRAINT "offering_data_alternatives_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "offering_specialisations" ADD CONSTRAINT "offering_specialisations_offering_name_fkey" FOREIGN KEY ("offering_name") REFERENCES "offerings"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_specialisations" ADD CONSTRAINT "offering_specialisations_specialisation_id_fkey" FOREIGN KEY ("specialisation_id") REFERENCES "specialisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_data" ADD CONSTRAINT "offering_data_offering_name_fkey" FOREIGN KEY ("offering_name") REFERENCES "offerings"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_data" ADD CONSTRAINT "offering_data_specialisation_id_fkey" FOREIGN KEY ("specialisation_id") REFERENCES "specialisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_data" ADD CONSTRAINT "offering_data_training_title_fkey" FOREIGN KEY ("training_title") REFERENCES "training_data"("training_title") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_data_alternatives" ADD CONSTRAINT "offering_data_alternatives_offering_data_id_fkey" FOREIGN KEY ("offering_data_id") REFERENCES "offering_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offering_data_alternatives" ADD CONSTRAINT "offering_data_alternatives_training_title_fkey" FOREIGN KEY ("training_title") REFERENCES "training_data"("training_title") ON DELETE CASCADE ON UPDATE CASCADE;
