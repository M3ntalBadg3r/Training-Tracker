-- Performance indexes for growing data volume.
--
-- The hot `training_taken` table was only indexed on `email` and
-- `training_title` individually. Report/compliance queries filter on
-- `training_title` together with the date columns (`expiry_date`,
-- `completed_date`) and, for gap/replacement reports, together with `email`.
-- Without composite indexes Postgres narrows by `training_title` and then
-- filters the remaining predicates row-by-row, which degrades linearly as the
-- table grows. `students.country` / `students.theatre` are primary scoping
-- filters (country/region/theatre reports + the DISTINCT theatre lookups) and
-- were unindexed.

-- CreateIndex
CREATE INDEX "training_taken_training_title_expiry_date_idx" ON "training_taken"("training_title", "expiry_date");

-- CreateIndex
CREATE INDEX "training_taken_training_title_completed_date_expiry_date_idx" ON "training_taken"("training_title", "completed_date", "expiry_date");

-- CreateIndex
CREATE INDEX "training_taken_training_title_email_idx" ON "training_taken"("training_title", "email");

-- CreateIndex
-- Standalone completed_date index for the "achieved in last N months" report,
-- which filters completed_date across all titles (no training_title predicate).
CREATE INDEX "training_taken_completed_date_idx" ON "training_taken"("completed_date");

-- CreateIndex
CREATE INDEX "students_country_idx" ON "students"("country");

-- CreateIndex
CREATE INDEX "students_theatre_idx" ON "students"("theatre");
