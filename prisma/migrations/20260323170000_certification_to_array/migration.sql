-- Migrate certification from single nullable text to text array
-- First, convert existing NULL values to empty string so NOT NULL can be applied
UPDATE "training_data"
  SET "certification" = ''
  WHERE "certification" IS NULL;

-- Apply NOT NULL constraint (all rows now have a value)
ALTER TABLE "training_data"
  ALTER COLUMN "certification" SET NOT NULL;

-- Drop any existing default before type change to avoid cast error
ALTER TABLE "training_data"
  ALTER COLUMN "certification" DROP DEFAULT;

-- Convert to text array: empty string becomes empty array, others become single-element arrays
ALTER TABLE "training_data"
  ALTER COLUMN "certification" TYPE text[]
  USING CASE
    WHEN "certification" = '' THEN '{}'::text[]
    ELSE ARRAY["certification"]
  END;

-- Set the default as a proper text array
ALTER TABLE "training_data"
  ALTER COLUMN "certification" SET DEFAULT '{}'::text[];
