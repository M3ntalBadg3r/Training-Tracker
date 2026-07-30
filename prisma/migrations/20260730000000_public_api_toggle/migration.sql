-- Global on/off switch for the read-only public API (`/api/public/v1/*`).
-- Defaults to false so the API is disabled until a SuperAdmin enables it,
-- on fresh installs and on upgrade alike.
ALTER TABLE "system_settings" ADD COLUMN "public_api_enabled" BOOLEAN NOT NULL DEFAULT false;
