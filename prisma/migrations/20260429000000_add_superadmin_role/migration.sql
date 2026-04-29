-- AlterEnum: add SuperAdmin role.
-- Note: ALTER TYPE ... ADD VALUE cannot run inside a transaction; this migration is
-- intentionally a single statement so Prisma's per-migration transaction wrapper allows it.
ALTER TYPE "Role" ADD VALUE 'SuperAdmin';
