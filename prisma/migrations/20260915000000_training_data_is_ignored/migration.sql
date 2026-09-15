-- Marks a catalogue entry the admin has decided is not needed. Ignored entries
-- are excluded from reporting (see src/lib/reportable-training.ts) and badged
-- in the admin catalogue, but their TrainingTaken rows are left untouched — a
-- learner's own record still shows the completion.
-- AlterTable
ALTER TABLE "training_data" ADD COLUMN "is_ignored" BOOLEAN NOT NULL DEFAULT false;
