-- Configurable per-field header alias list for the student-import wizard.
-- Defaults are seeded here (matching the previous hard-coded list) plus the
-- additional aliases requested for CRM/LMS-style exports. Once seeded the
-- table is fully user-managed at /admin/system-settings (no reset path).

CREATE TABLE "import_aliases" (
    "id" SERIAL NOT NULL,
    "target_field" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_aliases_target_field_alias_key"
    ON "import_aliases"("target_field", "alias");

CREATE INDEX "import_aliases_target_field_idx"
    ON "import_aliases"("target_field");

INSERT INTO "import_aliases" ("target_field", "alias") VALUES
    -- Full Name
    ('fullName', 'Full Name'),
    ('fullName', 'Student Name'),
    -- First Name
    ('firstName', 'First Name'),
    -- Last Name
    ('lastName', 'Last Name'),
    -- Email Address
    ('email', 'Email Address'),
    ('email', 'Email'),
    ('email', 'Student Email'),
    -- Theatre
    ('theatre', 'Theatre'),
    ('theatre', 'Theater'),
    ('theatre', 'Acct Theatre'),
    -- Country
    ('country', 'Country'),
    ('country', 'Billing Country'),
    -- Cert/Training
    ('title', 'Cert/Training'),
    ('title', 'Title'),
    ('title', 'ILT Name'),
    ('title', 'Cert'),
    ('title', 'Test'),
    -- Completed Date
    ('completedDate', 'Completed Date'),
    ('completedDate', 'Completion date'),
    ('completedDate', 'Date Completed'),
    -- Company
    ('company', 'Company');
