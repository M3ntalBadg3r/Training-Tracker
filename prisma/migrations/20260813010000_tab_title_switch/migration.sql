-- Lets an install drop the application name from the browser tab entirely,
-- rather than only replacing it. With this false the page renders no <title>,
-- so the browser falls back to displaying the URL.
ALTER TABLE "system_settings" ADD COLUMN "show_name_in_tab" BOOLEAN NOT NULL DEFAULT true;
