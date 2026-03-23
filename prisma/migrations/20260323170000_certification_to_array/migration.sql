-- Migrate certification from single nullable text to text array
-- First, convert existing single values into single-element arrays
ALTER TABLE "training_data"
  ALTER COLUMN "certification" SET DEFAULT '{}',
  ALTER COLUMN "certification" SET NOT NULL;

UPDATE "training_data"
  SET "certification" = CASE
    WHEN "certification" IS NULL THEN '{}'
    ELSE ARRAY["certification"]::text[]
  END;

ALTER TABLE "training_data"
  ALTER COLUMN "certification" TYPE text[]
  USING "certification"::text[];
