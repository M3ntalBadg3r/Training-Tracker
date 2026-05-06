-- Pre-flight: fail loudly if existing usernames would collide after lowercasing.
-- The login system is moving to case-insensitive matching (lowercase-on-store);
-- if two rows differ only in case (e.g., "Alice" and "alice") we cannot safely
-- proceed without an admin manually resolving the duplicate.
DO $$
DECLARE
  collision_count INT;
BEGIN
  SELECT COUNT(*) INTO collision_count
  FROM (
    SELECT LOWER("username") AS lu
    FROM "users"
    GROUP BY LOWER("username")
    HAVING COUNT(*) > 1
  ) c;
  IF collision_count > 0 THEN
    RAISE EXCEPTION 'Username case-collision detected: % group(s) of users share a username after lowercasing. Resolve duplicates before re-running this migration.', collision_count;
  END IF;
END $$;

-- Normalise existing usernames to lowercase so the pre-existing unique index keeps working.
UPDATE "users" SET "username" = LOWER("username");

-- Defence-in-depth: a functional unique index that rejects case-insensitive
-- duplicates even if a future code path forgets to lowercase before insert.
CREATE UNIQUE INDEX "users_username_lower_key" ON "users" (LOWER("username"));

-- Last-login tracking columns (nullable: existing users have no recorded login yet).
ALTER TABLE "users"
  ADD COLUMN "last_login_at" TIMESTAMP(3),
  ADD COLUMN "last_login_ip" TEXT;

-- Force-MFA flag. When true, login succeeds but the issued JWT carries a
-- `pendingMfaEnrollment` claim that the proxy uses to lock the user to /setup-mfa
-- until they enrol. Cleared by the MFA verify route on success.
ALTER TABLE "users"
  ADD COLUMN "must_enable_mfa" BOOLEAN NOT NULL DEFAULT false;
