-- Session revocation counter for user accounts.
--
-- Every session token carries the `session_epoch` its user had at login.
-- Bumping this column invalidates every token minted before the bump, which is
-- what makes a password change (or an admin password reset) end the other
-- sessions instead of leaving them valid until the absolute session cap.
--
-- Default 0 matches the "no claim present" case, so tokens issued before this
-- column existed keep working until their user's next password change.
ALTER TABLE "users" ADD COLUMN "session_epoch" INTEGER NOT NULL DEFAULT 0;
