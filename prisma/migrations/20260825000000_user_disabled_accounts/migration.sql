-- Reversible account suspension for user accounts.
--
-- `disabled_at` is the single source of truth: NULL means the account is
-- enabled, so every existing row (and every row from an older backup archive
-- that predates these columns) is enabled by default.
--
-- `disabled_by` stores the disabling admin's username as a snapshot rather than
-- a foreign key to users(id): the full-restore paths strip row ids and let
-- Postgres reassign them, so a stored id would point at the wrong user — or a
-- nonexistent one — after a restore.
ALTER TABLE "users" ADD COLUMN "disabled_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "disabled_by" TEXT;
ALTER TABLE "users" ADD COLUMN "disabled_reason" TEXT;
