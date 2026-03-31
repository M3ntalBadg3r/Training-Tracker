-- Make training_type and training_title nullable on program_data
-- Required for Global-level requirements which are based on compliant theatre
-- counts rather than a specific training type/title.

ALTER TABLE "program_data" ALTER COLUMN "training_type" DROP NOT NULL;
ALTER TABLE "program_data" ALTER COLUMN "training_title" DROP NOT NULL;
