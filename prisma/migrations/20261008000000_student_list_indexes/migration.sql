-- Indexes for the server-paged student list (`GET /api/students`,
-- `lib/students-list.ts`), which orders by full_name with an email tiebreak
-- (`ORDER BY full_name, email LIMIT … OFFSET …`), either unscoped or within
-- one company (`company_id IN ($1)`, which Postgres plans as `= $1`).
--
-- Without them every page is a sequential scan plus a sort of the whole scope:
-- a top-N heapsort for page 1, and for a deep page a full sort that spills to
-- disk. With them the planner walks the index in order and stops after
-- OFFSET + LIMIT rows. Both serve the descending sort too (backward scan).
--
-- `students_company_id_idx` is left in place; the composite's leading column
-- covers it, but dropping it is a separate decision.

-- CreateIndex
CREATE INDEX "students_full_name_email_idx" ON "students"("full_name", "email");

-- CreateIndex
CREATE INDEX "students_company_id_full_name_email_idx" ON "students"("company_id", "full_name", "email");
