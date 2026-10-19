-- Optional free-text description on a program, shown on its cards, its admin
-- page and its dashboard. Nullable with no default, so every existing program
-- simply has none. Re-runnable.
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "description" TEXT;
