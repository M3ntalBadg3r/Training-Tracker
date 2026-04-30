# CLAUDE.md — Training Tracker

## Project Overview

Training Tracker is a full-stack Next.js app for managing student certifications, accreditations, and instructor-led training (ILT). Built with Next.js 16 (App Router), React 19, PostgreSQL, Prisma 7, TypeScript, and Tailwind CSS v4.

## Quick Start

```bash
npm install
npx prisma migrate deploy && npx prisma generate
npm run dev          # http://localhost:3000
```

Requires a `.env` file with `DATABASE_URL` and `JWT_SECRET` (see `.env.example`).

## Key Commands

- `npm run dev` — Start dev server
- `npm run build` — Production build
- `npm start` — Start production server
- `npx prisma migrate dev` — Create/apply migrations in dev
- `npx prisma migrate deploy` — Apply migrations in prod
- `npx prisma generate` — Regenerate Prisma client
- `npx prisma studio` — Open DB browser

## Project Structure

```
src/
  app/
    api/          # Route handlers (dashboard, students, training-data, import, reports, admin, auth)
    dashboard/    # Dashboard page (metrics + charts)
    students/     # Student list + [email] detail page
    training/     # Training catalog + [fullTitle] detail page
    reports/      # Index page + 9 reports: by-product-type, by-function, expiring-soon, last-12-months, trained-not-certified, coverage, catalogue-health, program-compliance-trend, renewal-forecast
    account/      # User account page (profile, MFA setup)
    admin/        # Admin pages (region-data, training-data, backup, import, users, companies, cleanup, updates, scheduled-exports, program-data)
    programs/     # Partner program compliance dashboards
      aps/        # Authorized Professional Services (APS) compliance dashboard
      global-diamond/  # Global Diamond compliance dashboard
    login/        # Login page
    setup/        # First-run setup wizard
    layout.tsx    # Root layout with AuthProvider + CompanyScopeProvider + AppShell
  components/
    layout/       # Sidebar, PageHeader, AppShell
    ui/           # Modal, Badge, HelpModal, KpiStrip, DateRangePicker
    auth/         # AuthProvider (context + useAuth hook)
    company/      # CompanyScopeProvider (selected company in header) + CompanySwitcher
    theme/        # ThemeProvider (dark mode context + useTheme hook)
    data-table/   # Generic DataTable (search, sort, filter, paginate) + GroupedRows (grouped tbody with subtotals + expand/collapse)
    admin/        # Admin-only widgets: ProviderCredentialWizard, CredentialHealthBanner
  hooks/          # useDebounce
  proxy.ts       # Route protection (auth + role checks)
  lib/
    prisma.ts     # Prisma client singleton (PrismaPg adapter)
    auth.ts       # JWT, password hashing, TOTP/MFA utilities
    company-scope.ts # Resolve a user's allowed company ids; helpers for `?companyId=` filtering
    cron-auth.ts  # HMAC-SHA256 signature verification for cron endpoints
    rate-limit.ts # In-memory sliding-window rate limiter for auth endpoints
    utils.ts      # Date helpers, formatters, label mappers
    chart-theme.ts # useChartTheme() hook — theme-aware Recharts axis/grid/tooltip + COLORS palette
    group-by.ts    # rollUp(country, region, theatre) + groupRows() — country->region->theatre rollup with theatre fallback for null/'unknown' regions
    program-compliance.ts # Shared compliance calculations (email-set queries, OR-logic union, per-theatre breakdown) used by APS, Global Diamond, and Program Compliance Trend
    export.ts     # CSV/Excel/PDF export utilities (browser-side, triggers download)
    server-export.ts  # Server-side CSV/Excel/PDF generation (returns Buffer)
    report-queries.ts # Server-side Prisma queries for each report type
    export-destinations.ts  # Delivery logic: local file, email, Google Drive, Box, OneDrive
    run-export.ts     # Core export execution shared by run-now and cron-based executor
    oauth-state.ts    # Signed state-cookie + redirect-URI helpers for credential OAuth wizard
    oauth-providers.ts # Per-provider OAuth metadata (URLs, scopes, expiry thresholds) + exchange/refresh helpers
    credential-health.ts # Probe + persist health for ExportCredential rows; powers banner + daily cron
    help-content.tsx
  types/
    index.ts      # Shared TypeScript interfaces
prisma/
  schema.prisma   # Data model
  migrations/     # Migration history
deploy/           # install.sh, update.sh, install-remote.sh, perform-update.sh, check-update.sh, auto-update.sh, auto-backup.sh, auto-export.sh, auto-credential-check.sh, systemd service
```

## Data Model

- **Student** — PK: `email`. Fields: fullName, theatre, country, companyId (FK → Company.id, NOT NULL). `theatre` is denormalized from `RegionData.theatre`: it's set on create/edit by looking up the country, and the student forms surface it as a read-only auto-derived field.
- **Company** — PK: `id`. Fields: name (unique). Tenants: students, scheduled exports, and (via `UserCompany`) Admin/User access lists are all scoped per-company.
- **UserCompany** — Composite PK: (userId, companyId). Many-to-many between non-SuperAdmin users and the companies they can see. SuperAdmins are not represented in this table; they implicitly have access to every company.
- **TrainingData** — PK: `trainingTitle`. Fields: fullTitle (display name), trainingType, productType, function, link, certification[].
- **TrainingTaken** — FK: email → Student, trainingTitle → TrainingData. Fields: completedDate, expiryDate (auto: +2 years).
- **RegionData** — PK: `country`. Fields: region, theatre (nullable). Theatre is the source of truth for a country's theatre — student add/edit forms only show countries with a populated theatre, and student imports flag (and override) any row whose theatre disagrees.
- **User** — PK: `id` (auto-increment). Fields: username (unique), passwordHash, displayName, role (SuperAdmin/Admin/User), mfaEnabled, mfaSecret. Has many `UserCompany` rows when role ≠ SuperAdmin.
- **ScheduledExport** — PK: `id`. Fields: name, companyId (FK → Company.id, NOT NULL — the export only includes data for this company), reportType, format, destination, config (JSON), enabled, frequency, time, dayOfWeek?, dayOfMonth?, lastRunAt?, lastStatus?, lastError?.
- **ExportCredential** — PK: `id`, unique: `provider`. Fields: provider, config (JSON), lastCheckedAt?, lastCheckStatus? (`"ok"` | `"expired"` | `"failed"`), lastCheckError?, lastSuccessAt?. Stores SMTP/OAuth credentials per delivery provider; the health columns drive the dashboard banner and per-card status badge. Cloud providers (`google-drive`, `box`, `onedrive`) all use OAuth refresh-token flows captured by the wizard at `/admin/scheduled-exports`; OneDrive is delegated (uploads to the connecting user's `/me/drive`).
- **Specialisation** — PK: `id` (auto-increment). Fields: name (unique). Admin-managed list of product specialisations for partner programs.
- **ProgramData** — PK: `id` (auto-increment). FK: specialisationId → Specialisation, trainingTitle → TrainingData. Fields: programName, level (ProgramLevel enum), trainingType?, trainingTitle?, quantityRequired, minimumPerTheatre?. Training fields are nullable (null = "count compliant theatres" mode for APS-style Global entries). minimumPerTheatre is used by Global Diamond for per-theatre minimum enforcement. Has many ProgramDataAlternative (OR logic alternatives).
- **ProgramDataAlternative** — PK: `id` (auto-increment). FK: programDataId → ProgramData (cascade delete), trainingTitle → TrainingData (cascade delete). Fields: trainingType, trainingTitle. Stores alternative trainings that also satisfy a ProgramData requirement (OR logic). Students with any alternative training count toward the requirement's quantity.

### Enums
- **TrainingType**: `Certification`, `Accreditation`, `InstructorLedTraining`
- **ProductType**: `Cortex`, `SASE`, `Cloud`, `Strata`, `Foundation`
- **FunctionType**: `Sales`, `PreSales`, `Deployments`
- **Role**: `SuperAdmin` (full access, can manage companies/users/system), `Admin` (scoped to assigned companies; can edit data within scope but cannot manage users/companies/region-data/training-data/backup/cleanup/updates), `User` (read-only, scoped to assigned companies)
- **ProgramLevel**: `Country`, `Theatre`, `Global`

## Architecture Notes

- Path alias: `@/*` → `./src/*`
- Pages are server components by default; client components use `"use client"` directive.
- Authentication uses JWT tokens in HTTP-only cookies (via `jose` library). Proxy (`src/proxy.ts`) protects all routes. API routes have additional `requireAuth()` guards for defense-in-depth.
- Three roles: **SuperAdmin** (system-wide), **Admin** (scoped to assigned companies via `UserCompany`), **User** (read-only, scoped). The proxy enforces a SuperAdmin-only allow-list (`/admin/users`, `/admin/companies`, `/admin/training-data`, `/admin/region-data`, `/admin/program-data`, `/admin/backup`, `/admin/cleanup`, `/admin/updates`). API routes apply company scoping via `lib/company-scope.ts` helpers (`getAuthorizedCompanyIds`, `resolveCompanyFilter`, `canAccessCompany`).
- All data-bearing API endpoints accept a `?companyId=` query parameter that is intersected with the caller's allowed companies; the global header switcher (in `AppShell`, backed by `CompanyScopeProvider`) sets it client-side and persists the selection in `localStorage` (`tt.selectedCompany`). SuperAdmins can choose "All companies"; everyone else sees only the companies they've been granted.
- Importing data requires a Company column or a per-import default company. SuperAdmins auto-create unknown companies on the fly; other Admins get an "out of scope" error if a row references a company they don't have access to. When a row's email matches an existing student in another company, the row is processed but the company assignment is preserved (warn-only).
- TOTP-based MFA supported via `otpauth` library. Optional per-user, managed in Admin > Users.
- First-run setup wizard creates the initial admin account when no users exist in the database.
- Multiple `trainingTitle`s can map to the same `fullTitle`. Deduplication by `email + fullTitle + trainingType` is applied in dashboard and training-page APIs to avoid double-counting.
- Expiry is always completedDate + 2 years (computed in `lib/utils.ts:computeExpiryDate`).
- Sidebar collapse state is persisted to `localStorage`.
- Rate limiting is applied to auth endpoints (login, MFA verify, setup, password reset) via `lib/rate-limit.ts`.
- Cron endpoints (auto-backup, scheduled-exports) authenticate via HMAC-SHA256 signatures using `CRON_SECRET` env var (`lib/cron-auth.ts`).
- Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) are configured in `next.config.ts`.
- Backup exports exclude sensitive user fields (passwordHash, mfaSecret) for security.

## Coding Conventions

- Enum values: PascalCase (`InstructorLedTraining`, `PreSales`)
- DB columns: snake_case via Prisma `@map`
- API responses: camelCase JSON
- TypeScript interfaces use Row/Record suffixes (`StudentRow`, `TrainingRecord`)
- ESLint: `eslint-config-next` with core-web-vitals + TypeScript rules (strict mode)
- No implicit any — strict TypeScript enabled

## Common Pitfalls

- **fullTitle vs trainingTitle**: `trainingTitle` is the internal DB key (from imports); `fullTitle` is the human-readable display name. Multiple trainingTitles can share a fullTitle — always group/deduplicate by fullTitle when counting.
- **Date handling**: All dates flow through `lib/utils.ts`. Use `parseDate()` for parsing, `formatDate()` for display (DD Mmm YYYY), `computeExpiryDate()` for expiry.
- **Import column mapping**: The import API auto-maps columns with fuzzy matching and supports type aliases (e.g., `ilt` → `InstructorLedTraining`, `pre-sales` → `PreSales`).
- **Manual training-taken mutations**: `POST /api/training-taken` creates a single TrainingTaken row; `PATCH /api/training-taken/[id]` updates only `completedDate`. Both are Admin-only and both auto-derive `expiryDate = completedDate + 2 years` via `computeExpiryDate` — never accept an explicit expiry. Manual `POST` enforces the same `email + trainingTitle + completedDate` dedupe key as the import flow and returns 409 on duplicate.
- **Student theatre is derived, not user-input**: `POST /api/students` and `PUT /api/students/[email]` ignore any `theatre` in the body and look it up from `RegionData` by `country`. They reject the request if the country isn't in Region Data with a populated theatre. The student forms expose this as a country dropdown plus a read-only theatre/region display. The import flow at `/api/import` does the same lookup row-by-row and surfaces a warning whenever the CSV's theatre disagrees with the curated value (the curated value wins). Read-only consumers (`GET /api/region-data/countries`) feed the dropdown.

## Git Workflow

- **Development branch**: `dev` — All changes MUST be committed and pushed here first.
- **Production branch**: `master` — After testing on dev, merge `dev` to `master` and push.
- **Dev releases**: After pushing to `dev`, create a GitHub **pre-release** via `gh api` (with `"prerelease": true`). Dev systems (`UPDATE_CHANNEL=dev`) will see these.
- **Stable releases**: After pushing to `master`, create a GitHub **full release** via `gh api` (with `"prerelease": false`). Production systems (`UPDATE_CHANNEL=stable`) will see these.
- **GitHub operations**: Always use `gh api` directly for all GitHub API interactions (creating releases, tags, etc.). Do NOT use `gh release create`, MCP tools, or `git tag && git push` — the git remote is proxied and they will fail. The `gh` CLI is always available and authenticated.
- **Creating a release** (example):
  ```bash
  gh api repos/M3ntalBadg3r/Training-Tracker/releases \
    -f tag_name="v<version>" \
    -f target_commitish="$(git rev-parse HEAD)" \
    -f name="v<version>" \
    -f body="Release notes here" \
    -F prerelease=true   # false for stable releases
  ```
- **Update channels**: Systems set `UPDATE_CHANNEL` in `.env` to `"stable"` (default) or `"dev"`. The update check API and CLI scripts use this to determine whether to include pre-releases.

## Mandatory Post-Change Rules

After every change, you MUST complete these steps before considering the task done:

1. **Bump the version** — Update `"version"` in `package.json` by incrementing 0.01 for each change (e.g., 0.40 → 0.41 → 0.42).
2. **Update README.md** — If the change affects how the system is used (new features, changed behavior, new pages, config changes), update `README.md` to reflect it.
3. **Update the help system** — If the change affects user-facing behavior, update the relevant section in `src/lib/help-content.tsx` so the in-app help stays accurate.
4. **Update CLAUDE.md** — If the change modifies the project structure (new/renamed/removed files or directories) or the data model (new/changed models, fields, enums, or relationships), update the relevant sections in this file.
5. **Create a GitHub release** — After pushing, create a GitHub release via `gh api` (see example in Git Workflow section above) with friendly release notes describing what's new, changed, and fixed.

## Deployment

Production runs via systemd at `/opt/training-tracker` on port 3000. See `deploy/` for install/update scripts.
