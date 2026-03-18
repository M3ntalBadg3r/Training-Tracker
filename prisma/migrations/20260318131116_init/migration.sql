-- CreateEnum
CREATE TYPE "TrainingType" AS ENUM ('Certification', 'Accreditation', 'Instructor-Led Training');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('Cortex', 'SASE', 'Cloud', 'Strata', 'Foundation');

-- CreateEnum
CREATE TYPE "FunctionType" AS ENUM ('Sales', 'Pre-Sales', 'Deployments');

-- CreateTable
CREATE TABLE "students" (
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "theatre" TEXT NOT NULL,
    "country" TEXT NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "training_taken" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "training_title" TEXT NOT NULL,
    "completed_date" TIMESTAMP(3) NOT NULL,
    "expiry_date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_taken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_data" (
    "training_title" TEXT NOT NULL,
    "full_title" TEXT NOT NULL,
    "training_type" "TrainingType" NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "function" "FunctionType" NOT NULL,
    "link" TEXT,

    CONSTRAINT "training_data_pkey" PRIMARY KEY ("training_title")
);

-- CreateTable
CREATE TABLE "region_data" (
    "country" TEXT NOT NULL,
    "region" TEXT NOT NULL,

    CONSTRAINT "region_data_pkey" PRIMARY KEY ("country")
);

-- CreateIndex
CREATE INDEX "training_taken_email_idx" ON "training_taken"("email");

-- CreateIndex
CREATE INDEX "training_taken_training_title_idx" ON "training_taken"("training_title");

-- CreateIndex
CREATE INDEX "training_data_full_title_idx" ON "training_data"("full_title");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_country_fkey" FOREIGN KEY ("country") REFERENCES "region_data"("country") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_taken" ADD CONSTRAINT "training_taken_email_fkey" FOREIGN KEY ("email") REFERENCES "students"("email") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_taken" ADD CONSTRAINT "training_taken_training_title_fkey" FOREIGN KEY ("training_title") REFERENCES "training_data"("training_title") ON DELETE CASCADE ON UPDATE CASCADE;
