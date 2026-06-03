-- Legacy lifecycle for Certification/Accreditation training data.
-- `is_legacy` flags a cert/accreditation as retired/superseded.
-- `replaced_by` lists the trainingTitles of the replacement Cert/Accreditation(s)
-- (alternatives — completing any one counts). Empty means no replacement.
ALTER TABLE "training_data" ADD COLUMN "is_legacy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "training_data" ADD COLUMN "replaced_by" TEXT[] NOT NULL DEFAULT '{}';
