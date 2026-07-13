-- Add a configurable inactivity (idle) session timeout, in minutes.
ALTER TABLE "system_settings" ADD COLUMN "session_idle_minutes" INTEGER NOT NULL DEFAULT 30;
