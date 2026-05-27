-- Per-user display preference for dates. Null means "inherit system default".
-- Stored as a plain string (one of "DD/MM/YYYY" or "MM/DD/YYYY"); application
-- code validates the value before write.
ALTER TABLE "users"
  ADD COLUMN "date_format" TEXT;

-- Singleton table holding system-wide preferences. The CHECK constraint plus
-- the @default(1) on the Prisma model guarantees there is at most one row.
CREATE TABLE "system_settings" (
  "id"            INTEGER PRIMARY KEY DEFAULT 1,
  "date_format"   TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by_id" INTEGER,
  CONSTRAINT "system_settings_singleton" CHECK ("id" = 1),
  CONSTRAINT "system_settings_updated_by_id_fkey"
    FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Seed the singleton row so application code can always read it without a
-- create branch on first access.
INSERT INTO "system_settings" ("id", "date_format") VALUES (1, 'DD/MM/YYYY')
ON CONFLICT ("id") DO NOTHING;
