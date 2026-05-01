-- Add nullable theatre column to RegionData. Existing rows get NULL;
-- SuperAdmin populates them via the Region Data admin page.
ALTER TABLE "region_data" ADD COLUMN "theatre" TEXT;
