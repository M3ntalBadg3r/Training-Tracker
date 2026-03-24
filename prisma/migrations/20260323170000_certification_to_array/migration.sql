-- Migrate certification from single nullable text to text array
-- First, convert existing NULL values to empty string so NOT NULL can be applied
UPDATE "training_data"
  SET "certification" = ''
  WHERE "certification" IS NULL;

-- Now safe to set NOT NULL and default
ALTER TABLE "training_data"
  ALTER COLUMN "certification" SET DEFAULT '{}',
  ALTER COLUMN "certification" SET NOT NULL;

-- Convert to text array: empty string becomes empty array, others become single-element arrays
ALTER TABLE "training_data"
  ALTER COLUMN "certification" TYPE text[]
  USING CASE
    WHEN "certification" = '' THEN '{}'::text[]
    ELSE ARRAY["certification"]
  END;
