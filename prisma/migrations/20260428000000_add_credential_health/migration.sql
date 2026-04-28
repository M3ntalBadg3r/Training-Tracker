-- AlterTable
ALTER TABLE "export_credentials"
  ADD COLUMN "last_checked_at"   TIMESTAMP(3),
  ADD COLUMN "last_check_status" TEXT,
  ADD COLUMN "last_check_error"  TEXT,
  ADD COLUMN "last_success_at"   TIMESTAMP(3);
