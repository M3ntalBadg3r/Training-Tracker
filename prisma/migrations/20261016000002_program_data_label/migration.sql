-- Optional display name for a program requirement ("4 per target country —
-- any sales cert"), shown in place of its training and alternatives list.
-- Display only: nothing that counts compliance reads it. Additive and
-- re-runnable.
ALTER TABLE "program_data" ADD COLUMN IF NOT EXISTS "label" TEXT;
