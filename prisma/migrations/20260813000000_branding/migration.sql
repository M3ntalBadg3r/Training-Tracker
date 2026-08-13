-- White-labelling: app name, brand colour, uploaded logo/favicon and the two
-- login-page header switches, all on the SystemSetting singleton.
--
-- The images are stored base64-encoded in TEXT rather than as bytea because the
-- config/full backup pipeline JSON-stringifies this row wholesale; a Buffer
-- would serialise as {"type":"Buffer","data":[...]} and need bespoke
-- rehydration on restore, while a base64 string round-trips for free.
--
-- Every column is NOT NULL DEFAULT or nullable, so upgrades need no backfill.
ALTER TABLE "system_settings" ADD COLUMN "app_name" TEXT NOT NULL DEFAULT 'Training Tracker';
ALTER TABLE "system_settings" ADD COLUMN "brand_color" TEXT;
ALTER TABLE "system_settings" ADD COLUMN "logo_data" TEXT;
ALTER TABLE "system_settings" ADD COLUMN "logo_mime_type" TEXT;
ALTER TABLE "system_settings" ADD COLUMN "favicon_data" TEXT;
ALTER TABLE "system_settings" ADD COLUMN "favicon_mime_type" TEXT;
ALTER TABLE "system_settings" ADD COLUMN "login_show_name" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "system_settings" ADD COLUMN "login_show_logo" BOOLEAN NOT NULL DEFAULT true;
