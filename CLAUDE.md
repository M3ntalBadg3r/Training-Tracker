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
    reports/      # Trained-but-not-certified report
    account/      # User account page (profile, MFA setup)
    admin/        # Admin pages (region-data, training-data, backup, import, users, cleanup, updates, scheduled-exports)
    login/        # Login page
    setup/        # First-run setup wizard
    layout.tsx    # Root layout with AuthProvider + AppShell
  components/
    layout/       # Sidebar, PageHeader, AppShell
    ui/           # Modal, Badge, HelpModal
    auth/         # AuthProvider (context + useAuth hook)
    theme/        # ThemeProvider (dark mode context + useTheme hook)
    data-table/   # Generic DataTable (search, sort, filter, paginate)
  hooks/          # useDebounce
  proxy.ts       # Route protection (auth + role checks)
  lib/
    prisma.ts     # Prisma client singleton (PrismaPg adapter)
    auth.ts       # JWT, password hashing, TOTP/MFA utilities
    utils.ts      # Date helpers, formatters, label mappers
    export.ts     # CSV/Excel/PDF export utilities (browser-side, triggers download)
    server-export.ts  # Server-side CSV/Excel/PDF generation (returns Buffer)
    report-queries.ts # Server-side Prisma queries for each report type
    export-destinations.ts  # Delivery logic: local file, email, Google Drive, Box, OneDrive
    run-export.ts     # Core export execution shared by run-now and cron-based executor
    help-content.tsx
  types/
    index.ts      # Shared TypeScript interfaces
prisma/
  schema.prisma   # Data model
  migrations/     # Migration history
deploy/           # install.sh, update.sh, install-remote.sh, perform-update.sh, check-update.sh, auto-update.sh, auto-backup.sh, auto-export.sh, systemd service
```

## Data Model

- **Student** — PK: `email`. Fields: fullName, theatre, country.
- **TrainingData** — PK: `trainingTitle`. Fields: fullTitle (display name), trainingType, productType, function, link, certification[].
- **TrainingTaken** — FK: email → Student, trainingTitle → TrainingData. Fields: completedDate, expiryDate (auto: +2 years).
- **RegionData** — PK: `country`. Fields: region.
- **User** — PK: `id` (auto-increment). Fields: username (unique), passwordHash, displayName, role (Admin/User), mfaEnabled, mfaSecret.
- **ScheduledExport** — PK: `id`. Fields: name, reportType, format, destination, config (JSON), enabled, frequency, time, dayOfWeek?, dayOfMonth?, lastRunAt?, lastStatus?, lastError?.
- **ExportCredential** — PK: `id`, unique: `provider`. Fields: provider, config (JSON). Stores SMTP/OAuth/API credentials per delivery provider.

### Enums
- **TrainingType**: `Certification`, `Accreditation`, `InstructorLedTraining`
- **ProductType**: `Cortex`, `SASE`, `Cloud`, `Strata`, `Foundation`
- **FunctionType**: `Sales`, `PreSales`, `Deployments`
- **Role**: `Admin`, `User`

## Architecture Notes

- Path alias: `@/*` → `./src/*`
- Pages are server components by default; client components use `"use client"` directive.
- Authentication uses JWT tokens in HTTP-only cookies (via `jose` library). Proxy (`src/proxy.ts`) protects all routes. API routes have additional `requireAuth()` guards for defense-in-depth.
- Two fixed roles: **Admin** (full access) and **User** (read-only, no admin pages). Role checked in proxy and API routes.
- TOTP-based MFA supported via `otpauth` library. Optional per-user, managed in Admin > Users.
- First-run setup wizard creates the initial admin account when no users exist in the database.
- Multiple `trainingTitle`s can map to the same `fullTitle`. Deduplication by `email + fullTitle + trainingType` is applied in dashboard and training-page APIs to avoid double-counting.
- Expiry is always completedDate + 2 years (computed in `lib/utils.ts:computeExpiryDate`).
- Sidebar collapse state is persisted to `localStorage`.

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

## Git Workflow

- **Development branch**: `claude/student-certification-tracker-60g7Q` — All changes MUST be committed and pushed here first.
- **Production branch**: `master` — After pushing to the development branch, merge to `master` and push.
- **Releases**: After pushing to `master`, create a GitHub release via `gh api` with friendly release notes.

## Mandatory Post-Change Rules

After every change, you MUST complete these steps before considering the task done:

1. **Bump the version** — Update `"version"` in `package.json` by incrementing 0.01 for each change (e.g., 0.40 → 0.41 → 0.42).
2. **Update README.md** — If the change affects how the system is used (new features, changed behavior, new pages, config changes), update `README.md` to reflect it.
3. **Update the help system** — If the change affects user-facing behavior, update the relevant section in `src/lib/help-content.tsx` so the in-app help stays accurate.
4. **Update CLAUDE.md** — If the change modifies the project structure (new/renamed/removed files or directories) or the data model (new/changed models, fields, enums, or relationships), update the relevant sections in this file.
5. **Create a GitHub release** — After pushing, create a GitHub release with `gh release create v<version>` including friendly release notes describing what's new, changed, and fixed.

## Deployment

Production runs via systemd at `/opt/training-tracker` on port 3000. See `deploy/` for install/update scripts.
