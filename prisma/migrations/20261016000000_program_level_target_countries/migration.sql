-- AlterEnum: add the TargetCountries requirement level.
--
-- ADD VALUE only, in a migration of its own: PostgreSQL refuses to *use* a
-- newly added enum value inside the transaction that added it ("unsafe use of
-- new value"), and the next migration both references it in a CHECK and
-- converts existing rows to it.
ALTER TYPE "ProgramLevel" ADD VALUE IF NOT EXISTS 'TargetCountries' AFTER 'CountrySet';
