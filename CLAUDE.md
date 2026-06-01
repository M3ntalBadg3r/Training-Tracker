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
    reports/      # Index page + 10 reports: by-product-type, by-function, expiring-soon, last-12-months, trained-not-certified, coverage, comparison (theatre/region/country side-by-side matrix + chart, client-side over training-records + students), catalogue-health, program-compliance-trend, renewal-forecast
    account/      # User account page (profile, MFA setup)
    admin/        # Admin pages (region-data, training-data, backup, import, users, companies, system-settings, cleanup, updates, scheduled-exports, program-data) and SuperAdmin-only API: api/admin/security/encrypt-secrets seals plaintext mfaSecret + ExportCredential.config rows once after ENCRYPTION_KEY is provisioned.
    programs/     # Partner program compliance dashboards
      aps/        # Authorized Professional Services (APS) compliance dashboard
      global-diamond/  # Global Diamond compliance dashboard
    login/        # Login page
    setup/        # First-run setup wizard
    setup-mfa/    # Forced MFA enrolment page (chromeless; reached when JWT carries `pendingMfaEnrollment` claim)
    layout.tsx    # Root layout with AuthProvider + DateFormatProvider + CompanyScopeProvider + AppShell
  components/
    layout/       # Sidebar, PageHeader, AppShell
    ui/           # Modal, Badge, HelpModal, KpiStrip, DateRangePicker, DatePicker (single-date, format-aware)
    auth/         # AuthProvider (context + useAuth hook)
    company/      # CompanyScopeProvider (selected company in header) + CompanySwitcher
    theme/        # ThemeProvider (dark mode context + useTheme hook)
    date-format/  # DateFormatProvider (per-user + system date format context, useDateFormat hook)
    data-table/   # Generic DataTable (search, sort, filter, paginate) + GroupedRows (grouped tbody with subtotals + expand/collapse)
    admin/        # Admin-only widgets: ProviderCredentialWizard, CredentialHealthBanner, UpdateAvailableBanner (dashboard "update available" alert, SuperAdmin-only, session-dismissible)
  hooks/          # useDebounce
  proxy.ts       # Route protection (auth + role checks). Note: in Next.js 16+ the official middleware filename is `proxy.ts` (formerly `middleware.ts`).
  lib/
    prisma.ts     # Prisma client singleton (PrismaPg adapter)
    auth.ts       # JWT, password hashing, TOTP/MFA utilities (sealMfaSecret/openMfaSecret wrap users.mfa_secret with the lib/crypto envelope)
    crypto.ts     # AES-256-GCM envelope encryption (sealConfig/openConfig + sealMfaSecret helpers); keyed by ENCRYPTION_KEY env var
    company-scope.ts # Resolve a user's allowed company ids; helpers for `?companyId=` filtering
    date-format.ts # Format-aware date parser/formatter: DD/MM/YYYY vs MM/DD/YYYY. parseDateWith is strict (rejects month=15, day=31/02); detectFormat scans cells and reports the unambiguous format (or null when both fit / cells conflict). UTC-anchored to keep date-only values stable across timezones.
    system-settings.ts # SystemSetting singleton accessor (in-memory 30s cache); getSystemDateFormat / setSystemDateFormat
    cron-auth.ts  # HMAC-SHA256 signature verification for cron endpoints
    rate-limit.ts # In-memory sliding-window rate limiter for auth endpoints. getClientIp walks X-Forwarded-For from the right and skips entries in TRUSTED_PROXIES.
    utils.ts      # Date helpers, formatters, label mappers, safeDecodeParam (URL-decode that returns null on malformed input instead of throwing)
    olx.ts        # OLX parent-completion materialization (recomputeParentsForStudent / ForSubItem / ForMany / AllStudentsForParent)
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
- **TrainingData** — PK: `trainingTitle`. Fields: fullTitle (display name), trainingType, productType, function, link, certification[]. OLX parents and OLX sub-items are both stored here; the parent ↔ sub-item membership lives in `OlxSubItemRelation`. Only `Certification`, `InstructorLedTraining`, and `OLX` rows can carry certifications — sub-items have an empty array.
- **TrainingTaken** — FK: email → Student, trainingTitle → TrainingData. Fields: completedDate, expiryDate (auto: +2 years). When a student completes every sub-item of an OLX parent, the system materialises a `TrainingTaken` row on the parent with `completedDate` = the latest sub-item date and `expiryDate` = +2 years; this row is removed if the student later loses any sub-item completion. A "single-item OLX" is just an OLX parent with no sub-items — it's treated as a normal training row.
- **OlxSubItemRelation** — Composite PK: (parentTrainingTitle, subItemTrainingTitle). Many-to-many between an OLX parent and its sub-items (a sub-item may belong to multiple parents). Cascade deletes from either side.
- **RegionData** — PK: `country`. Fields: region, theatre (nullable). Theatre is the source of truth for a country's theatre — student add/edit forms only show countries with a populated theatre, and student imports flag (and override) any row whose theatre disagrees.
- **User** — PK: `id` (auto-increment). Fields: username (unique, **stored lowercase** for case-insensitive login — backed by both the existing `users_username_key` index on the (already-lowercased) value and a `users_username_lower_key` functional unique index on `LOWER(username)`), passwordHash, displayName, role (SuperAdmin/Admin/User), mfaEnabled, mfaSecret, mustEnableMfa (when true and the user has not yet enabled MFA, the JWT issued at login carries a `pendingMfaEnrollment` claim that the proxy uses to lock the user to `/setup-mfa`; cleared automatically by `/api/auth/mfa/verify` on success), lastLoginAt, lastLoginIp, dateFormat (nullable per-user display preference; null inherits the `SystemSetting` default). Has many `UserCompany` rows when role ≠ SuperAdmin.
- **SystemSetting** — Singleton row keyed at `id=1` (enforced by CHECK constraint + Prisma default). Fields: dateFormat (`"DD/MM/YYYY"` or `"MM/DD/YYYY"` — default for the whole instance), updatedAt, updatedById (FK → User, SET NULL on delete). Read with `lib/system-settings.ts:getSystemDateFormat()` (cached in-process for 30s); SuperAdmin updates via `/admin/system-settings`.
- **ScheduledExport** — PK: `id`. Fields: name, companyId (FK → Company.id, NOT NULL — the export only includes data for this company), reportType, format, destination, config (JSON), enabled, frequency, time, dayOfWeek?, dayOfMonth?, lastRunAt?, lastStatus?, lastError?.
- **ExportCredential** — PK: `id`, unique: `provider`. Fields: provider, config (JSON), lastCheckedAt?, lastCheckStatus? (`"ok"` | `"expired"` | `"failed"`), lastCheckError?, lastSuccessAt?. Stores SMTP/OAuth credentials per delivery provider; the health columns drive the dashboard banner and per-card status badge. Cloud providers (`google-drive`, `box`, `onedrive`) all use OAuth refresh-token flows captured by the wizard at `/admin/scheduled-exports`; OneDrive is delegated (uploads to the connecting user's `/me/drive`).
- **Specialisation** — PK: `id` (auto-increment). Fields: name (unique). Admin-managed list of product specialisations for partner programs.
- **ProgramData** — PK: `id` (auto-increment). FK: specialisationId → Specialisation, trainingTitle → TrainingData. Fields: programName, level (ProgramLevel enum), trainingType?, trainingTitle?, quantityRequired, minimumPerTheatre?. Training fields are nullable (null = "count compliant theatres" mode for APS-style Global entries). minimumPerTheatre is used by Global Diamond for per-theatre minimum enforcement. Has many ProgramDataAlternative (OR logic alternatives).
- **ProgramDataAlternative** — PK: `id` (auto-increment). FK: programDataId → ProgramData (cascade delete), trainingTitle → TrainingData (cascade delete). Fields: trainingType, trainingTitle. Stores alternative trainings that also satisfy a ProgramData requirement (OR logic). Students with any alternative training count toward the requirement's quantity.

### Enums
- **TrainingType**: `Certification`, `Accreditation`, `InstructorLedTraining`, `OLX`, `OLXSubItem`
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
- TOTP-based MFA supported via `otpauth` library. Optional per-user, managed in Admin > Users. Admins can also flip `mustEnableMfa` on a user (Add User modal: "Require MFA at first login", default checked; Edit User modal: "Require MFA at next login") to force enrolment on the user's next session — proxy.ts pins them to `/setup-mfa` until verified.
- Login is **case-insensitive** on `username`. The login route (`src/app/api/auth/login/route.ts`), the first-run setup wizard, and the admin user create endpoint all lowercase the input before any DB read or write; existing rows are normalised by the `20260506000000_add_user_login_tracking_and_force_mfa` migration.
- First-run setup wizard creates the initial admin account when no users exist in the database.
- Multiple `trainingTitle`s can map to the same `fullTitle`. Deduplication by `email + fullTitle + trainingType` is applied in dashboard and training-page APIs to avoid double-counting.
- Expiry is always completedDate + 2 years (computed in `lib/utils.ts:computeExpiryDate`).
- Sidebar collapse state is persisted to `localStorage`.
- Rate limiting is applied to auth endpoints (login, MFA verify, setup, change-password, password reset, MFA disable) via `lib/rate-limit.ts`. The IP extractor walks `X-Forwarded-For` from the right and skips entries listed in `TRUSTED_PROXIES` (default `127.0.0.1,::1`) so per-IP limits aren't trivially spoofable when the app is fronted by a reverse proxy.
- Cron endpoints (auto-backup, scheduled-exports) authenticate via HMAC-SHA256 signatures using `CRON_SECRET` env var (`lib/cron-auth.ts`).
- Security headers (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Content-Security-Policy) are set in `next.config.ts`. CSP uses `script-src 'self' 'unsafe-inline'` because Next.js 16 App Router emits inline hydration scripts and loads chunks via non-nonced `<script src="/_next/static/...">` tags on statically-rendered pages. Stricter nonce/strict-dynamic CSP is tracked as future work — see audit plan; would require force-dynamic rendering and per-page nonce wiring.
- Secrets at rest: `User.mfaSecret` and `ExportCredential.config` are sealed with AES-256-GCM via `lib/crypto.ts` (envelope format `enc:v1:<base64>`). `ENCRYPTION_KEY` (64 hex chars) is required. After provisioning the key, a SuperAdmin POSTs `/api/admin/security/encrypt-secrets` once to seal any pre-existing plaintext rows; the endpoint is idempotent.
- Backup archives are encrypted at rest when `ENCRYPTION_KEY` is configured: `generateBackupArchive()` wraps the JSZip output with `encryptBuffer()` from `lib/crypto.ts` (4-byte magic `TT01` + IV + GCM tag + ciphertext) and the file is saved as `*.zip.enc`. `loadBackupArchive()` detects the magic and decrypts before handing bytes to JSZip, so older `*.zip` archives still restore. Backups already exclude `passwordHash` and `mfaSecret`; the encryption protects the remaining PII (Students, TrainingTaken, Companies).
- Step-up auth: an Admin/SuperAdmin disabling another user's MFA (`/api/auth/mfa/disable`) or resetting another user's password (`/api/admin/users/[id]/reset-password` — SuperAdmin-only) must re-authenticate with their own password and, if MFA is enabled on their account, a current TOTP code.
- OAuth redirect URI: built from `APP_BASE_URL` when set, otherwise from request headers. Configure `APP_BASE_URL` in production so the URI is not influenced by `X-Forwarded-Host`.
- All admin paths in `proxy.ts`'s `SUPER_ADMIN_PREFIXES` (users, companies, region/training/program data, system-settings, specialisations, backup, cleanup, updates, wipe, security) also enforce SuperAdmin in their handlers via `requireSuperAdmin` for defense-in-depth.

## Coding Conventions

- Enum values: PascalCase (`InstructorLedTraining`, `PreSales`)
- DB columns: snake_case via Prisma `@map`
- API responses: camelCase JSON
- TypeScript interfaces use Row/Record suffixes (`StudentRow`, `TrainingRecord`)
- ESLint: `eslint-config-next` with core-web-vitals + TypeScript rules (strict mode)
- No implicit any — strict TypeScript enabled

## Common Pitfalls

- **fullTitle vs trainingTitle**: `trainingTitle` is the internal DB key (from imports); `fullTitle` is the human-readable display name. Multiple trainingTitles can share a fullTitle — always group/deduplicate by fullTitle when counting.
- **Date handling**: `parseDate()` in `lib/utils.ts` is now **strict ISO yyyy-mm-dd only** (it used to be `new Date(str)` which silently re-interpreted UK-format dates as US format and produced future-dated rows in the DB). Slash-format CSV/Excel cells must go through `parseDateWith(str, format)` from `lib/date-format.ts` with an explicit `DateFormat`. For display, server code uses `formatDateWith(date, await getSystemDateFormat())`; client components call `useDateFormat()` from `@/components/date-format/DateFormatProvider` and read `formatDate` / `formatDateTime` off the hook so per-user preferences win over the system default. `computeExpiryDate()` is unchanged.
- **Date format mismatch on import**: `/api/import` calls `detectFormat()` on the completed-date column. If the cells force a format that disagrees with the assumed format (system default unless `dateFormatOverride` was provided), the endpoint returns `409 { error: "dateFormatMismatch", assumedFormat, detectedFormat, sampleConflicts }`. The upload UI shows an "Use detected format for this import" modal; accepting re-posts with `dateFormatOverride` set. Ambiguous columns (every cell fits both formats) parse silently with a single warning in `summary.errors`.
- **Native Excel date cells**: the xlsx branch of `/admin/import` reads the sheet with `{ raw: true }` (not `raw:false`) so Excel date-typed cells surface as their numeric **serial** instead of a flattened display string (which loses precision — `7/8/21`, or a raw serial `46147`). The UI decodes serials in the mapped completed-date column to ISO via `excelSerialToIso(serial, date1904)` from `lib/date-format.ts` before sending (and in the preview), honoring the workbook's 1900/1904 epoch flag. Native dates are unambiguous, so they bypass `detectFormat`; only genuine text date cells (and CSV) drive the format prompt. The server is unchanged.
- **Day/month-swapped native Excel dates**: a `DD/MM`-locale Excel round-trip can silently transpose the day and month of native date serials. `/admin/import` detects the corruption by its symptom client-side — ≥ 1 native serial in the mapped completed-date column decodes to a **future** date whose swap is a valid non-future date (`detectExcelDateSwap`). A completion date can't be in the future, so this is unambiguous evidence of transposition, and clean files (no future dates) never trigger it. On confirm, `resolveDateCell(raw, unswap)` swaps a native serial via `swapMonthDayIso(iso)` from `lib/date-format.ts` **only when the swapped date is valid and ≤ today** — so genuine recent dates (whose swap would be future) and day > 12 serials (which can't swap) are preserved, correctly handling *mixed* files (swapped historical cells alongside genuine recent ones). Text cells are untouched and still flow through `detectFormat`. Gated by `unswapExcelDates`/`swapAcknowledged` state. Client-side only; the server is unchanged.
- **Returning dates from APIs**: Endpoints that hand date strings to the client must return ISO 8601 (`tt.completedDate.toISOString()`) — never pre-formatted strings. The display layer formats via `useDateFormat()`. This is why `/api/training-taken` and `/api/students/[email]` no longer wrap dates in `formatDate()`.
- **Import column mapping**: The import API auto-maps columns with fuzzy matching and supports type aliases (e.g., `ilt` → `InstructorLedTraining`, `pre-sales` → `PreSales`). The student-import wizard (`/admin/import`) matches each target field against a per-field header **alias list** in `TARGET_FIELDS` (e.g. email ← `Email Address`/`Email`, theatre ← `Theatre`/`Theater`, completed date ← `Completed Date`/`Completion date`/`Date Completed`, and the `title` field — displayed as **Cert/Training** — ← `Cert/Training`/`Title`/`ILT Name`/`Cert`). The mapping **key stays `title`**, so the API payload is unchanged despite the display-label rename. The name can come from a single `Full Name` column **or** separate `First Name` + `Last Name` columns (merged into `Student.fullName` per-row in `mappedRows`); the wizard requires Full Name OR both parts. Based on which name columns auto-map, the wizard shows only the relevant name dropdowns/preview columns (`nameMode` → `visibleFields`): Full Name only, First+Last only, or all (when both or neither are detected). An explicit Full Name value wins per-row, then First+Last, then a name derived from the email local part.
- **Manual training-taken mutations**: `POST /api/training-taken` creates a single TrainingTaken row; `PATCH /api/training-taken/[id]` updates only `completedDate`. Both are Admin-only and both auto-derive `expiryDate = completedDate + 2 years` via `computeExpiryDate` — never accept an explicit expiry. Manual `POST` enforces the same `email + trainingTitle + completedDate` dedupe key as the import flow and returns 409 on duplicate.
- **Student theatre is derived, not user-input**: `POST /api/students` and `PUT /api/students/[email]` ignore any `theatre` in the body and look it up from `RegionData` by `country`. They reject the request if the country isn't in Region Data with a populated theatre. The student forms expose this as a country dropdown plus a read-only theatre/region display. The import flow at `/api/import` does the same lookup row-by-row and surfaces a warning whenever the CSV's theatre disagrees with the curated value (the curated value wins). Read-only consumers (`GET /api/region-data/countries`) feed the dropdown.
- **OLX parent completion is computed, not imported**: never write a `TrainingTaken` row for an OLX parent directly from imports — the parent row is materialised by `lib/olx.ts` after the student's last sub-item lands. Mutations on `TrainingTaken` (POST/PATCH/DELETE) and `/api/import` all call `recomputeParentsForSubItem` / `recomputeParentsForMany`. The training data import accepts a `Parent Training Title` column (comma-separated for multi-parent sub-items); presence of that column forces the row's `trainingType` to `OLXSubItem`. Reports that count completions (`/api/reports/training-records`, `/api/reports/coverage`, `/api/reports/renewal-forecast`, `/api/dashboard`, `report-queries.ts`) filter out `OLXSubItem` rows from `TrainingTaken` so a sub-item never double-counts with its parent. The "Trained But Not Certified" report treats OLX parents the same as ILTs.

## Git Workflow

- **Development branch**: `dev` — All changes MUST be committed and pushed here first.
- **Production branch**: `master` — After testing on dev, merge `dev` to `master` and push.
- **Dev releases**: After pushing to `dev`, create a GitHub **pre-release** via `gh api` (with `"prerelease": true`). Dev systems (`UPDATE_CHANNEL=dev`) will see these.
- **Stable releases**: After pushing to `master`, create a GitHub **full release** via `gh api` (with `"prerelease": false`). Production systems (`UPDATE_CHANNEL=stable`) will see these.
- **GitHub operations**: Always use `gh api` directly for all GitHub API interactions (creating releases, tags, etc.). Do NOT use `gh release create`, MCP tools, or `git tag && git push` — the git remote is proxied and they will fail. The `gh` CLI is always available and authenticated.
- **Release tag conventions** (mandatory — the update comparator depends on these):
  - **Stable**: tag = `v<version>`, e.g. `v1.38`. The version (after stripping the leading `v`) MUST equal `package.json`'s `version` field.
  - **Dev pre-release**: tag = `v<version>-dev`, e.g. `v1.38-dev`. The `-dev` suffix is the only suffix the update comparator strips before numeric comparison.
  - **Do NOT use** any other suffix (`-stable`, `-rc`, `-beta`, `-hotfix`, …). The version comparator (`parseVersionNumber` in `src/app/api/admin/updates/check/route.ts` and the inline regex in `deploy/check-update.sh`) only strips `-dev`; any other suffix is folded into the minor parse and produces ties or unintended ordering.
  - **Same numeric version on both channels is fine but ties on the dev channel**: the comparator uses strict `>` so when `v1.38` (stable) and `v1.38-dev` (pre-release) both parse to `1038`, whichever GitHub returns first wins. Both tags should always reference functionally equivalent code (the master merge is a `--no-ff` of the dev tip), so this is harmless. If you need the dev channel to clearly diverge, bump `package.json` ahead on dev (e.g. cut `v1.39-dev` while stable is still on `v1.38`).
- **Creating a release** (examples):
  ```bash
  # Dev pre-release (after pushing to dev)
  gh api repos/M3ntalBadg3r/Training-Tracker/releases \
    -f tag_name="v<version>-dev" \
    -f target_commitish="$(git rev-parse origin/dev)" \
    -f name="v<version>" \
    -f body="Release notes here" \
    -F prerelease=true

  # Stable release (after merging dev → master and pushing)
  gh api repos/M3ntalBadg3r/Training-Tracker/releases \
    -f tag_name="v<version>" \
    -f target_commitish="$(git rev-parse origin/master)" \
    -f name="v<version>" \
    -f body="Release notes here" \
    -F prerelease=false
  ```
- **Update channels**: Systems set `UPDATE_CHANNEL` in `.env` to `"stable"` (default) or `"dev"`. The update check API and CLI scripts use this to determine whether to include pre-releases. Both channels list `releases?per_page=20`, optionally filter out `prerelease`/`draft`, and pick the highest version using `major*1000 + minor` after stripping `v` and `-dev`.

## Mandatory Post-Change Rules

After every change, you MUST complete these steps before considering the task done:

1. **Bump the version** — Update `"version"` in `package.json` by incrementing 0.01 for each change (e.g., 0.40 → 0.41 → 0.42).
2. **Update README.md** — If the change affects how the system is used (new features, changed behavior, new pages, config changes), update `README.md` to reflect it.
3. **Update the help system** — If the change affects user-facing behavior, update the relevant section in `src/lib/help-content.tsx` so the in-app help stays accurate.
4. **Update CLAUDE.md** — If the change modifies the project structure (new/renamed/removed files or directories) or the data model (new/changed models, fields, enums, or relationships), update the relevant sections in this file.
5. **Create a GitHub release** — After pushing, create a GitHub release via `gh api` using the tag conventions in the Git Workflow section above (`v<version>-dev` for dev pre-releases, `v<version>` for stable). Write friendly release notes describing what's new, changed, and fixed.

## Deployment

Production runs via systemd at `/opt/training-tracker` on port 3000. See `deploy/` for install/update scripts.
