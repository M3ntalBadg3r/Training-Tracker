-- The theatres a program operates in. Empty = every theatre, which is what
-- every existing program means today, so the default leaves them unchanged.
-- Re-runnable.
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "included_theatres" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
