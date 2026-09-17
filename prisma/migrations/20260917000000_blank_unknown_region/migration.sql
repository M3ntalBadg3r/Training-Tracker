-- Blank the placeholder region the student import used to invent.
--
-- When the import met a country that was not in Region Data it auto-created the
-- row with the literal region "Unknown". That was never a region name — it was
-- "we don't know yet" — but nothing downstream knew that, so the word was
-- rendered verbatim in the Region Data table, every geography filter dropdown,
-- the student detail sub-line, every report's Region column and every export.
--
-- The empty string is now the canonical "no region defined" state (the same
-- shape `theatre`/`iso_code` already use, except that `region` is NOT NULL), so
-- convert the existing placeholders. Matching is case/whitespace-insensitive
-- because the value also arrived via imports and hand edits over time.
UPDATE "region_data"
SET "region" = ''
WHERE LOWER(TRIM("region")) = 'unknown';
