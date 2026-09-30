-- AlterEnum: add the Region and CountrySet requirement levels.
--
-- ADD VALUE only. PostgreSQL refuses to *use* a newly added enum value inside
-- the transaction that added it ("unsafe use of new value"), and the CHECK
-- constraint in the next migration references both values — so they live in
-- their own migration, which `prisma migrate deploy` commits separately.
ALTER TYPE "ProgramLevel" ADD VALUE 'Region' AFTER 'Country';
ALTER TYPE "ProgramLevel" ADD VALUE 'CountrySet' AFTER 'Region';
