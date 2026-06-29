# Training Tracker

A full-stack application for tracking student certifications, accreditations, and instructor-led training programs across product lines and business functions.

Built with Next.js, React, PostgreSQL, and Prisma.

---

## Table of Contents

- [Getting Started](#getting-started)
  - [Quick Install (curl)](#quick-install-curl)
  - [Installation Script](#installation-script)
  - [Update Script](#update-script)
  - [Service Management](#service-management)
  - [Troubleshooting](#troubleshooting)
- [Authentication & Users](#authentication--users)
- [Dashboard](#dashboard)
- [Students](#students)
- [Training Catalog](#training-catalog)
- [Import Data](#import-data)
- [Reports](#reports)
- [Admin](#admin)
  - [Region Data](#region-data)
  - [Training Data](#training-data)
  - [User Management](#user-management)
  - [Backup & Restore](#backup--restore)
  - [Updates](#updates)
  - [Scheduled Report Exports](#scheduled-report-exports)
  - [Program Data](#program-data)
  - [Wipe Data](#wipe-data)
  - [API Keys](#public-api)
- [Public API](#public-api)
- [Partner Programs](#partner-programs)
- [Data Model](#data-model)
- [Exporting Data](#exporting-data)

---

## Getting Started

The `deploy/` directory contains scripts for installing and updating Training Tracker on a Debian-based Linux server, **LXC container, or VM**. The scripts need root privileges: on an LXC you are normally root already, while on a VM you typically log in as a regular user — in that case the scripts **automatically re-exec themselves under `sudo`**, so no manual elevation is required. (If `sudo` is not installed, they exit with a clear message.) The app itself runs as **root** on both LXC and VM, so the in-app updater and the scheduled cron jobs behave identically in either environment.

### Quick Install (curl)

Install Training Tracker on a fresh Debian-based system with a single command:

```bash
curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash
```

To install the **dev channel** (tracks the `dev` branch and receives pre-releases):

```bash
curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash -s -- --dev
```

This downloads the repository, installs all dependencies, sets up the database, and starts the application. On a VM where you are not root, pipe into `sudo` instead — `curl -sSL <url> | sudo bash` (a piped script has no file for the installer to re-exec, so the elevation must happen at the pipe). Append `-s -- --dev` after `sudo bash` for the dev channel.

### Installation Script

The installation script (`deploy/install.sh`) performs a complete, automated setup from a fresh Debian-based system. Run it from the project root:

```bash
bash deploy/install.sh
```

**What it does (9 steps):**

1. **Updates system packages** via `apt-get update`.
2. **Installs Node.js 22 LTS** from the NodeSource repository.
3. **Installs PostgreSQL** (if not already installed) and starts the service.
4. **Creates the database and user** — database `training_tracker`, user `tracker` with a **randomly generated password** (`openssl rand -hex 32`).
5. **Copies application files** to `/opt/training-tracker` (skipped if already running from that directory).
6. **Configures the `.env` file** — creates it if missing (or appends only the missing keys to an existing one) and **auto-generates strong random secrets** for `JWT_SECRET`, `ENCRYPTION_KEY`, and `CRON_SECRET`. It also **prompts** whether you use a public domain name (→ `APP_BASE_URL`) and whether you sit behind a reverse proxy (→ `TRUSTED_PROXIES`, asking for the proxy IP(s), default `127.0.0.1,::1`). On a non-interactive install (`curl | sudo bash` with no terminal) the prompts are skipped; you can preset them via environment variables instead, e.g. `APP_BASE_URL="https://tracker.example.com" bash deploy/install.sh`. Finally, when a system CA bundle is present it sets `NODE_EXTRA_CA_CERTS` so installs **behind an SSL-inspecting proxy/firewall** work (see below).
7. **Installs npm dependencies**, runs Prisma migrations, generates the Prisma client, and builds the application.
8. **Installs a systemd service** (`training-tracker.service`) so the application starts automatically on boot. Falls back to an init.d script if systemd is not available.
9. **Prints the URL** plus a configuration summary — including the **generated database password** (save it; it is also stored in `.env`).

**Database credentials:** database `training_tracker`, user `tracker`, with a random password generated at install time and written to `DATABASE_URL` in `/opt/training-tracker/.env`. The generated password is printed in the install summary. To change it later, edit `/opt/training-tracker/.env` (and the PostgreSQL role) and restart the service.

> **Behind an SSL-inspecting firewall?** Node.js ignores the OS trust store and uses its own CA list, so even after importing your firewall's root cert into Debian, Prisma's engine download (and the app's outbound HTTPS) can fail with `self-signed certificate in certificate chain`. The installer fixes this automatically by setting `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` in `.env` (which `systemd` injects at runtime, and the update scripts inherit). Make sure your firewall's root + intermediate certs are imported into the system store (`update-ca-certificates`) first. The update scripts also self-heal older installs that predate this.

### Update Script

The update script (`deploy/update.sh`) pulls the latest code and rebuilds the application with zero manual steps. Run it from anywhere:

```bash
bash deploy/update.sh
```

**What it does (5 steps):**

1. **Pulls latest changes** from the `main` branch via `git pull origin main`.
2. **Installs dependencies** — picks up any new or updated packages.
3. **Runs database migrations** — applies any new Prisma migrations and regenerates the client.
4. **Rebuilds the application** via `npm run build`.
5. **Restarts the service** using systemd (or init.d as fallback).

If the deployment directory is not a git repository (e.g. files were copied manually), the script will exit with an error at step 1. In that case, copy the updated files manually to `/opt/training-tracker` and run steps 2-5 yourself:

```bash
cd /opt/training-tracker
npm install
npx prisma migrate deploy
npx prisma generate
npm run build
systemctl restart training-tracker
```

### Service Management

Once installed, the application runs as a systemd service called `training-tracker`. Common commands:

```bash
# Check status
systemctl status training-tracker

# View live logs
journalctl -u training-tracker -f

# Restart the service
systemctl restart training-tracker

# Stop the service
systemctl stop training-tracker

# Start the service
systemctl start training-tracker
```

If systemd is not available (e.g. in some LXC containers), the init.d fallback is used instead:

```bash
/etc/init.d/training-tracker status
/etc/init.d/training-tracker restart
tail -f /var/log/training-tracker.log
```

The application runs on **port 3000** by default. To change the port, edit the `PORT` environment variable in `/opt/training-tracker/.env` or in the systemd service file at `/etc/systemd/system/training-tracker.service`, then restart the service.

### Troubleshooting

**Build fails on ARM64 with `Cannot find module '...lightningcss...node'`** — On
ARM64 hosts (e.g. a Debian VM on Apple Silicon) the build can fail while
compiling CSS with an error such as `Cannot find module
'../lightningcss.linux-arm64-gnu.node'`. This is a known npm bug
([npm/cli#4828](https://github.com/npm/cli/issues/4828)): a `package-lock.json`
generated on a different OS/architecture can leave the platform-native binary
uninstalled. The install and update scripts now detect this and reinstall
automatically. To fix an existing install manually, regenerate the lockfile for
your platform:

```bash
cd /opt/training-tracker
rm -rf node_modules package-lock.json
npm install
npx prisma generate
npm run build
systemctl restart training-tracker
```

**Update/build fails with `Killed` at step 5 (Building application)** — This is
the Linux out-of-memory (OOM) killer terminating `next build`: the VM ran out of
RAM. Next.js 16's production build uses **Turbopack**, which allocates native
memory, so Node's `--max-old-space-size` won't help — you need more available
memory. This is common on small VMs (especially 1–2 GB ARM64 instances). We
recommend at least **4 GB of RAM**, or add a swapfile:

```bash
sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # persist across reboots
```

Then re-run the update. The rollback is automatic and safe, so a killed build
leaves your previous version running and unaffected.

---

## Authentication & Users

Training Tracker requires authentication to access. On first launch (when no users exist), a setup wizard guides you through creating the initial administrator account.

### Roles

| Role | Access |
|------|--------|
| **SuperAdmin** | Full system access — companies, users, training/region catalogs, backup, cleanup, updates. Sees data for every company. The first user created during setup is a SuperAdmin. |
| **Admin** | Scoped to one or more assigned companies. Can edit students, training records, run imports, and manage scheduled exports for those companies, but cannot manage users, companies, or system-level catalogs. |
| **User** | Read-only access to Dashboard, Students, Training, Reports, and Programs — limited to their assigned companies. No edit/delete actions. |

### Companies

Training Tracker is multi-company: every student belongs to exactly one company, and Admin/User accounts see only the companies they have been granted access to. SuperAdmins manage the company list at **Admin → Companies** and assign companies to users via **Admin → Users**. A global **Company** dropdown in the page header filters the dashboard, students list, training, reports, and programs to the selected company; SuperAdmins also have an **All companies** option. The selection is remembered in your browser. Imports require a Company column or a per-import default company; SuperAdmins can auto-create new companies on the fly during import.

### Login

Navigate to any page and you will be redirected to the login screen. Enter your username and password. If MFA is enabled on your account, you will be prompted for a 6-digit code from your authenticator app. Usernames are **case-insensitive** — `Alice`, `alice`, and `ALICE` all match the same account.

### My Account

Click **My Account** in the sidebar to view your profile and manage MFA settings.

### Multi-Factor Authentication (MFA)

Any user can enable TOTP-based MFA from **My Account**. Click **Enable MFA**, scan the QR code with your authenticator app (Google Authenticator, Authy, Microsoft Authenticator, etc.), and enter the verification code. Once enabled, login requires a 6-digit code from your authenticator app. You can disable MFA from the same page (requires your password). Admins can also disable MFA for any user via **Admin > Users**.

#### Forcing MFA enrolment

SuperAdmins can require MFA enrolment for individual users:

- **At first login** — When creating a user via **Admin → Users → Add User**, the **Require MFA at first login** checkbox is enabled by default. The new user's first session will be locked to a chromeless `/setup-mfa` page until they enrol in TOTP MFA.
- **At next login** — In the **Edit User** modal, tick **Require MFA at next login** to flip the same flag on an existing user. Their next login will be locked to `/setup-mfa`.

The lock is enforced server-side: the user receives a session cookie that the proxy treats as valid only for the MFA enrolment routes — every other page and API returns 403 / redirects to `/setup-mfa` until enrolment completes.

### Last login tracking

The **Admin → Users** table shows two new columns: **Last login** (date + time, in 24h format) and **Last IP** (the source IP, taken from `X-Forwarded-For`). Both are updated on every successful login.

### First-Run Setup

On a fresh installation with no users in the database, all routes redirect to `/setup`. Fill in a username, display name, and password to create the first Admin account, then log in normally.

### Environment Variables

The `.env` file requires:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret key for JWT token signing (minimum 32 characters required) |
| `ENCRYPTION_KEY` | 64-character hex string (32 bytes) used to encrypt secrets at rest — TOTP shared secrets and OAuth/SMTP credentials. Generate with `openssl rand -hex 32`. **After enabling**, a SuperAdmin must POST `/api/admin/security/encrypt-secrets` once to seal any pre-existing rows. |
| `CRON_SECRET` | *(Optional)* Required only when using the auto-backup / auto-export shell scripts. Generate with `openssl rand -hex 32`. |
| `APP_BASE_URL` | *(Recommended in production)* Canonical externally-resolvable origin (e.g. `https://tracker.example.com`). Used to build OAuth redirect URIs without trusting `X-Forwarded-Host` headers, and to decide whether the auth cookie is marked `Secure` (an `https://` value marks it Secure; otherwise the cookie's Secure flag follows the request protocol, so plain-HTTP LAN access still works). |
| `TRUSTED_PROXIES` | *(Recommended in production)* Comma-separated list of trusted reverse-proxy IPs whose `X-Forwarded-For` entries are stripped when extracting the real client IP for rate limiting. Defaults to `127.0.0.1,::1`. |
| `NODE_EXTRA_CA_CERTS` | *(Optional)* Path to a CA bundle Node should trust in addition to its built-ins — set this when running behind an SSL-inspecting proxy/firewall so Prisma engine downloads and outbound HTTPS succeed. The installer sets it to `/etc/ssl/certs/ca-certificates.crt` automatically on Debian. |
| `GITHUB_TOKEN` | *(Optional)* GitHub personal access token — required for update checks **and git pulls** on private repositories |

#### Setting up GITHUB_TOKEN

If your Training Tracker repository is **private**, you need a GitHub personal access token. It is used for:
- Checking for new releases (admin **Updates** page and `deploy/check-update.sh`)
- Authenticating `git pull` during updates (`deploy/perform-update.sh` and `deploy/update.sh`)

1. Go to [GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token**
3. Give it a descriptive name (e.g. "Training Tracker Updates")
4. Under **Repository access**, select **Only select repositories** and choose your Training Tracker repo
5. Under **Permissions > Repository permissions**, set **Contents** to **Read-only**
6. Click **Generate token** and copy the value

Add it to your `.env` file:

```env
GITHUB_TOKEN="github_pat_your_token_here"
```

Then restart the application for the change to take effect.

**Fresh install on a private repo:** Pass `GITHUB_TOKEN` as an environment variable when running the install script and it will be used for the initial clone and persisted to `.env` automatically:

```bash
GITHUB_TOKEN="github_pat_your_token_here" bash -s -- [--dev] < install-remote.sh
```

**Existing install with a broken git remote URL:** If updates are failing with `could not read Password for 'https://ghp_…@github.com'`, the git remote was set with a malformed URL (token in the username slot). Fix it once with:

```bash
source /opt/training-tracker/.env
git -C /opt/training-tracker remote set-url origin \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/M3ntalBadg3r/Training-Tracker.git"
```

After that first successful update, the update scripts will automatically keep the remote URL in sync with the `GITHUB_TOKEN` value in `.env`, so you never need to set it manually again.

---

## Dashboard

The Dashboard is the default landing page and provides an at-a-glance overview of all training activity.

### Update Notifications

When a newer release is available, **SuperAdmins** see a dismissible blue banner at the top of the Dashboard linking to **Admin → Updates**. Dismissing it hides the banner for the current browser session; it reappears in a new session or as soon as an even newer release is published. Admins and Users do not see this banner.

### Night Mode

Click the **Moon** icon in the sidebar to toggle night (dark) mode. Click the **Sun** icon to switch back to light mode. Your preference is saved in the browser and persists across sessions.

### Theatre Filter

Use the **Theatre** dropdown in the top-right corner to filter all metrics and charts by theatre. Options include **Global** (all theatres) plus any theatres found in your student data (e.g., EMEA, NAM, LATAM, JAPAC). Previously selected theatres are cached for instant switching.

### Metric Cards

Five summary cards are displayed at the top. The four "earned" cards (Certifications, Accreditations, ILT, OLX) show the total number of completions of that type as the headline figure, plus a smaller **"Held by N students"** sub-metric underneath — the number of distinct students who have at least one completion of that type. The two lines together give a quick read of both depth (records) and breadth (reach).

| Metric | Description |
|--------|-------------|
| **Total Students** | Number of students in the system |
| **Certifications Earned** | Total certification completions across all students, with a sub-metric of distinct students holding any certification |
| **Accreditations Earned** | Total accreditation completions across all students, with a sub-metric of distinct students holding any accreditation |
| **Instructor-Led Trainings** | Total ILT completions across all students, with a sub-metric of distinct students who have attended any ILT |
| **OLX Completed** | Total OLX completions, with a sub-metric of distinct students who have completed any OLX. An OLX is "completed" once a student has completed every sub-item, or directly for single-item OLX entries. |

### Charts

| Chart | Type | Description |
|-------|------|-------------|
| **By Product Type** | Bar chart | Breakdown of Certifications, Accreditations, and ILT by product type (the admin-managed product type list) |
| **By Function** | Bar chart | Breakdown by function (Sales, Pre-Sales, Deployments) |
| **Expiring Soon** | Bar chart | Number of trainings expiring within 1, 3, and 6 months |
| **Currently Expired** | Bar chart | All certifications & trainings that have already lapsed, bucketed by how long ago they expired |
| **Achievement Over Time** | Line chart | Trend of completions over a selectable range (1/3/6/12 months or custom), with prior-period comparison |

Each chart is clickable — clicking a chart navigates to its corresponding detailed report in the **Reports** section.

---

## Students

### Student List

Navigate to **Students** in the sidebar to view all students in a table with columns:

- Full Name
- Email
- Theatre
- Region
- Country

Click **View** on any row to open the student's detailed record. The table's search, column filters, and sort order are mirrored to the URL, so opening a student and pressing **Back** restores the list exactly as you left it. Admins can click **Add Student** in the page header to create a student manually (Full Name, Email, Company, Country) without running an import. Country is a dropdown limited to entries in **Region Data** that have a Theatre assigned — Theatre and Region are auto-derived from the chosen country and shown read-only. To use a country that doesn't appear in the dropdown, ask a SuperAdmin to add it (with a Theatre) on the Region Data page first.

### Student Detail

The student detail page shows:

- **Contact Information** — Full Name, Email, Theatre, Country, and Region. Click **Edit** to modify Full Name, Email, or Country. Theatre and Region are auto-derived from the selected country (read-only). If the student's current country has no Theatre yet (post-migration), the dropdown shows it with a "needs theatre" suffix — switch to a configured country, or ask a SuperAdmin to set the Theatre in Region Data. Changes are previewed in a confirmation modal before saving.
- **Summary Badges** — Counts of active Certifications, Accreditations, Instructor-Led Trainings, and OLX completed, plus an **Expiring in 6 Months** badge counting the student's active Certifications and Accreditations whose expiry falls within the next six months.
- **Achievement Over Time** — A chart of the student's completed training per month across their full history.
- **Training Records** — A table of all trainings completed by the student, including Title (with link if available), Type, Product, Function, Completed Date, Expiry Date, and Active status.

While in edit mode, admins can also:

- **Add Training** — Pick a training from the catalog and a completed date. If the chosen training maps to multiple internal training titles, a second selector appears to disambiguate. Expiry is auto-set to two years after the completed date.
- **Edit** any row — Adjust the completed date; expiry is recalculated automatically.
- **Remove** any row — Queues the row for deletion when Save is clicked.
- **Delete Student** — Permanently removes the student and all of their training records, after a confirmation popup.

---

## Training Catalog

Navigate to **Training** in the sidebar to browse all available training programs.

The table displays:

- Full Title
- Training Type (Certification, Accreditation, Instructor-Led Training, OLX, or OLX Sub-Item)
- Product Type
- Function
- Link (if available)
- Students Taken (count of unique students who completed this training)

Filter the catalogue by **Theatre**, **Region**, **Country**, and **Active only** (restrict Students Taken to students whose training has not expired). The table's own search box, column filters, and sort order are also mirrored to the URL, so navigating into a training and pressing **Back** restores everything — page-level filters and table state. Use the **Export** button to download the **currently visible** rows (i.e. after every filter, search, and sort is applied) as CSV, Excel, or PDF — the menu offers two variants: **Catalogue** (one row per training, like the table view) and **Catalogue with students** (one row per training × student, useful for handing a partner / manager a full holders list).

Click **View Students** on any row to see which students have completed that training.

---

## Import Data

Navigate to **Import** in the sidebar to bulk-import student training records from CSV or Excel files.

### Import Workflow

1. **Upload** — Drag and drop or click to select a `.csv`, `.xls`, or `.xlsx` file.
2. **Column Mapping** — The system auto-maps columns where possible, recognising common header variants (e.g. `Email`/`Email Address`/`Student Email`, `Theatre`/`Theater`/`Acct Theatre`, `Country`/`Billing Country`, `Completed Date`/`Completion date`/`Date Completed`, `Full Name`/`Student Name`, and `Cert/Training`/`Title`/`ILT Name`/`Cert`/`Test`). The alias list is editable by SuperAdmins at **System Settings → Import Aliases**, so new CSV/Excel header variants can be added without a code change. Manually adjust any unmatched columns. The name dropdowns and preview columns adapt to the file: if it has only a **Full Name** column the First/Last fields are hidden, if it has **First Name** + **Last Name** (no full name) the Full Name field is hidden, and if it has both (or neither) all are shown. Required fields are:
   - Name — map **either** a single **Full Name** column **or** both **First Name** and **Last Name** (split names are merged into one record)
   - Email Address
   - Theatre
   - Country
   - Cert/Training
   - Completed Date
3. **Processing** — The system imports the data, creating students and training records as needed.
4. **Summary** — A summary shows counts of students created/updated, trainings imported/skipped, and any errors.

### Data Cleansing (Automatic)

During import, the following cleansing rules are applied automatically:

- **Email** — Converted to lowercase.
- **Full Name** — Leading/trailing spaces are removed and each word is capitalised (e.g. `jOHN sMITH` becomes `John Smith`).
- **First Name + Last Name** — When the file maps separate First Name and Last Name columns instead of a Full Name, the two are merged (`John` + `Smith` → `John Smith`) and capitalised the same way. If a row also has a Full Name value, that explicit value wins for that row.
- **Empty Full Name** — If no name value is present for a row, the system looks at the email address. If the local part (before the `@`) contains two words separated by a full stop (e.g. `jane.doe@company.com`), it uses those as the name (`Jane Doe`). Otherwise, the full email address is used as the name.

### Date Format Detection

Dates in the file are parsed strictly against the **system default date format** (set in **Admin → System Settings**). The import inspects the Completed Date column before committing any rows:

- **Match** — every cell fits the system default. The import runs silently.
- **Ambiguous** — every cell happens to fit both `DD/MM/YYYY` and `MM/DD/YYYY` (e.g. all days are 1–12). The import runs using the system default and adds a single line to the summary so you know the file couldn't be disambiguated.
- **Mismatch** — at least one cell forces the other format (e.g. month=15 in a system set to `DD/MM/YYYY`). The import pauses and shows a modal: **"This file looks like MM/DD/YYYY. Use it for this import?"** Accept to override for that import only; cancel and either fix the file or change the system default.
- **Internal conflict** — different cells force different formats (some `13/01/2025`, others `01/15/2025`). The import is rejected; clean the file and retry.

Rows that fail to parse against the chosen format are reported per-row with the expected format in the error message, rather than silently producing a wrong-date row.

**Native Excel dates:** When importing `.xlsx`/`.xls`, cells that Excel stores as real dates (rather than text) are read by their true underlying value and converted automatically — regardless of how they happen to be displayed in the sheet (e.g. `m/d/yy`, or an unformatted serial like `46147`). These never need the format prompt because their value is unambiguous. The format detection above therefore only applies to genuine **text** date cells (and all CSV cells).

**Day/month-swapped Excel dates:** Opening and re-saving an `MM/DD` file in an Excel set to a `DD/MM` locale can silently transpose the day and month of its native date cells (e.g. a true `2026-01-12` becomes a stored `2026-12-01`, landing in the future). The import detects this by its symptom — any native date cell in the Completed Date column that decodes to a **future** date which swapping the day and month would fix — and pauses to show a confirmation modal with sample corrections (`stored → corrected`). Choose **Yes, correct them** to repair the transposed dates, or **Import as-is** if the dates are genuinely correct. On confirm, each native date cell is swapped only when the corrected value is valid and not in the future, so **mixed files** (genuinely-correct recent dates sitting alongside swapped historical ones) are handled — recent dates and any cell whose day is above 12 are left untouched. Text date cells are unaffected and still flow through the format detection above.

---

## Reports

Navigate to **Reports** in the sidebar. Each report follows the same shape: a four-card **KPI strip** at the top, a **chart row** above the table, then a **filtered, groupable table** with CSV / Excel / PDF export. Charts are interactive — clicking a bar, segment, or month drills the table down to that slice. PDF / Excel / CSV exports remain tabular (the original column shapes for the existing five reports are unchanged so scheduled exports keep working).

### Common Features

- **Group by** — toggle theatre / region / country grouping on the table. The hierarchy rolls up: country → region → theatre, with a fallback to theatre when a student's region is missing or `unknown`.
- **Sortable columns** — every report table sorts by clicking a column header (click again to reverse; an ▲/▼ arrow marks the active column). Tables default to Full Name A–Z (or the report's natural primary column), and when grouping is on, rows sort within each theatre / region / country group.
- **Date-range picker** — limit results to a window (where applicable) with presets for Last 30 / 90 days, Last 12 months, Year to date, and All time.
- **Drill-down** — click a chart segment to apply that as a table filter; a small "Clear filter" link appears next to the chart while active.
- **Dark mode** — chart axes, gridlines, and tooltips adapt automatically alongside the rest of the app.

### By Product Type

Stacked bar of Certifications / Accreditations / ILTs per product, plus an active-vs-expired donut. Drill in by clicking a bar. Tick **Count people, not records (active holders)** to switch the chart and KPI cards from raw record counts to the number of distinct people who currently hold an active cert/training — so a learner with several certs in one product type is counted once per type rather than inflating the totals.

### By Function

Same shape as By Product Type, with the function dimension (Sales, Pre-Sales, Deployments) instead — including the same **Count people, not records (active holders)** toggle.

### Expiring Soon

Horizon bar showing records expiring within 1 / 3 / 6 / 12 months, plus a stacked theatre × month bar showing where expiry pressure clusters. Filter window is selectable up to 12 months.

### Currently Expired

Every certification & training whose latest completion has *already* lapsed — the inverse of Expiring Soon. Records are bucketed by how long ago they expired (≤ 1 month, 1–3, 3–6, 6–12, > 12 months) with a stacked bar by training type (click a band to filter the table) and an "Expired by Theatre" chart. Group by theatre/region/country, search by name/email, and export to CSV/Excel/PDF. Retired (legacy) certs are shown by default; tick **Exclude retired (legacy) certs** to hide them. Also available as a scheduled export.

### Achievement Over Time

Area chart of completions with a dashed prior-period comparison line, plus a top-10 leaderboard of most-completed trainings. Pick a preset time range (12, 6, 3, or 1 month) or a custom date range; the chart automatically buckets by day, week, or month depending on the window length. Click a bucket to filter the table to that day/week/month. Type and theatre filters update the chart as well as the table.

### Trained But Not Certified

Identifies students who have completed an **Instructor-Led Training** or an **OLX** (full sub-item set) but have **not** obtained the associated **Certification** (mapping configured in **Admin > Training Data**). Includes a gap-by-product chart and a top-buckets bar showing which theatres / regions / countries have the most gaps.

### Legacy Replacement Gap

Lists learners who hold a **legacy** Certification or Accreditation but have **not** taken its **replacement** (both configured in **Admin > Training Data** — tick **Mark as Legacy** and pick one or more **Replaced by** certs/accreditations). Replacements are alternatives: holding any one clears the learner. The expiry-horizon chart and **Already Expired / ≤ 1 / 3 / 6 / 12 months** window filter key on the learner's **legacy** training expiry, so you can prioritise who needs to migrate first. Two toggles tailor the view: **Include legacy with no replacement** (show holders of a retired cert that has no successor) and **Replacement must be active** (when off, a previously-held but now-expired replacement also counts as satisfied). Filter by type / product, group by theatre / region / country, and export to CSV / Excel / PDF. Also available as a scheduled export.

### Learner Achievement Scorecard

A learner-centric report — **one row per person** instead of per training. For each learner it shows counts of active **Certifications / Accreditations / ILTs / OLX**, a **Total**, the number **expiring soon** within a selectable window (1 / 3 / 6 months), **expired** achievements, **certification gaps** (completed a training without earning the mapped cert), and the **last achievement** date. A **Top Achievers** leaderboard chart highlights the most-certified learners for recognition. The whole roster is included, so learners with no completions surface with all-zero counts for follow-up. Counts are active-only by default; tick **Include expired in counts** to count expired completions too. Filter by theatre / region / country, search by name or email, sort any column, and export to CSV / Excel / PDF. Each name links through to the learner's detail page.

### Theatre / Region / Country Comparison

Compares geographies side by side. A single toggle switches the whole report between **Theatre**, **Region**, and **Country**. The matrix table lists, per geography: **headcount** (student population), counts of **Certifications / Accreditations / ILTs / OLX**, **total** trainings, **trainings per student**, and active trainings **expiring** in the next 3 and 6 months — every column sortable, with a totals row. The chart panel compares geographies by training type, function, or product (grouped bars) or plots completions **over time** (one line per geography, top 8 by volume). A time-range preset (3 / 6 / 12 months, all time, or a custom date range) plus Function / Product / Type filters narrow both the table and the chart. Counts respect the time range; the expiring columns always look forward from today.

### Training Catalogue Health

Per-training metrics: total completions, last-12-month completions, active students, expiring within 90 days, and uptake %. Highlights catalogue items with **zero completions** and **stale** trainings (no completions in 12 months). Top-10 leaderboards for active students and 90-day expiry pressure.

### Program Compliance Trend

Monthly snapshots — **12 months of history plus a 12-month forecast** — for the partner programs configured in **Admin > Program Data**. For each month-end, the same OR-logic union of primary + alternative trainings used by the live program dashboards is applied, counting only trainings that were completed by that month and still valid (so each point is a true snapshot of that moment, and historical lines reflect how compliance actually built up). The forecast (drawn as dashed lines after the "Forecast →" marker) assumes **no new completions** and shows compliance decaying as today's active certifications reach their expiry — an "if nothing changes" view of upcoming renewal gaps, summarised by the **Forecast 12-mo Δ** KPI. Use the **Theatre / Region / Country** filters to narrow the scope (shown in the "Showing" caption); the report is also scoped to the company selected in the header.

### Renewal Forecast

Projects how many of the trainings expiring in the next 12 months will be renewed vs lapsed, based on historical renewal behaviour. A renewal counts when a learner later re-completes the same training (at least 30 days after the previous completion, so duplicate rows aren't double-counted); an expired record with no later re-completion counts as a lapse. Renewal rate is computed per training (≥5 historical expiries), falling back to per product, then global. Includes a stacked bar by month (renewed vs lapsed) and an at-risk leaderboard of trainings ranked by projected lapses. **Theatre / Region / Country** filters scope the whole report — metric boxes, chart, and table update together.

---

## Admin

Navigate to **Admin** in the sidebar to access administrative functions. The Admin page provides links to sub-pages and a Danger Zone for data management.

### Region Data

Manage the mapping between countries, regions, and theatres. This page is the source of truth for a country's theatre — it drives the country dropdown on the student add/edit forms and validates theatres during student imports.

**Features:**

- **View** — Table of all countries with their assigned region and theatre. Countries with no theatre are flagged so you can fix them.
- **Search / Filter** — Filter by country, region, or theatre. The Theatre column has a "(missing)" filter to surface rows that still need a theatre assigned.
- **Add** — Add a new country with its region and (optionally) theatre. A country without a theatre cannot be selected for new students — set the theatre before assigning students.
- **Edit** — Click **Edit** on any row to modify the country, region, or theatre inline, then **Save** or **Cancel**.
- **Delete** — Remove a country/region mapping.
- **Import** — Upload a CSV or Excel file with `Country`, `Region`, and (optionally) `Theatre` columns. The system auto-maps columns and shows a preview before importing.
- **Export** — Download all region data (including theatre) as CSV, Excel, or PDF.

#### Student import behaviour

When importing student data (the **Admin → Import** page), each row's theatre is reconciled against Region Data:

- If the country exists in Region Data with a theatre, that theatre is the source of truth — any disagreement on the import row is overridden and surfaced as a warning in the **Issues** list.
- If the country exists in Region Data but has no theatre, the imported theatre is used as-is and a warning asks for the missing theatre to be set.
- If the country is brand new, Region Data auto-creates an entry with region "Unknown" and the imported theatre, and a warning asks a SuperAdmin to verify it.

### Training Data

Manage the definitions of all training programs in the system.

**Columns:**

| Column | Description |
|--------|-------------|
| **Training Title** | Short identifier used internally and during import matching |
| **Full Title** | Display name shown to users |
| **Type** | Certification, Accreditation, Instructor-Led Training, OLX, or OLX Sub-Item |
| **Product** | One of the configured product types (managed in Admin > Product Types) |
| **Function** | Sales, Pre-Sales, or Deployments |
| **Link** | Optional URL to training resources |
| **Certification** | Certification mapping (ILT only — see below) |
| **Legacy** | Marks a Certification/Accreditation as retired/superseded (see below) |
| **Replacement** | The Cert/Accreditation(s) that replace a legacy training |

**Features:**

The list shows **one row per Full Title** — the first-class "record". Because several Training Titles can map to the same Full Title, the page groups them so you manage the training as a single thing.

- **Add Training** — Click **Add Training** to open a modal form for creating a new training entry.
- **Edit (open the Full Title)** — Click **Edit** on any row (or click the row) to open the **Full Title detail page**, which lists every Training Title mapped to that Full Title and offers group-wide bulk actions (see below).
- **Search / Filter** — Search by training title or full title; filter by Type, Product, or Function. A **Show legacy only** toggle scopes the list to retired Certs/Accreds.
- **Import** — Upload a CSV or Excel file. Columns can be mapped to all fields including Certification. The system supports common aliases for type values (e.g. `ILT`, `cert`, `pre-sales`).
- **Export** — Download all training data as CSV or Excel (one row per Training Title, so it round-trips with import).

#### Full Title Detail Page

Opening a Full Title takes you to a dedicated page (like a student record) showing all of its mapped Training Titles. From here you can:

- **Rename Full Title** — Renames every mapped Training Title's Full Title at once.
- **Mark the whole Full Title as Legacy** — Cascades the legacy flag to **all** Certification/Accreditation Training Titles under it in one click (other types are unaffected). Pick the replacement as a **Full Title** (not individual titles) and it is expanded to the underlying replacements automatically.
- **Set Product / Function for all** — Apply a product type or function across every mapped Training Title.
- **Per-Title editing** — Each Training Title keeps its own Link, Certifications, OLX membership, and can still be edited or deleted individually.
- **Add Training Title** — Add another Training Title already attached to this Full Title.
- **Delete Full Title** — Remove the whole group (all mapped Training Titles) at once.

#### Newly-discovered trainings (import)

When a student import references a training title that doesn't exist yet, it is auto-created and highlighted in an amber **"needs attention"** section at the top of the page. When completing one, you can either **attach it to an existing Full Title** via a dropdown (it inherits that group's Type/Product/Function as editable defaults) or **create a new Full Title**, then click **Mark as Complete**.

#### Certification Mapping

The **Certification** column is available for trainings of type **Instructor-Led Training** and **OLX** (parent). It allows you to map an ILT or an OLX parent to one or more Certifications that it leads to. OLX Sub-Items cannot carry certifications.

- When editing or adding an ILT, a checkbox list of all available Certifications is shown.
- Select one or more Certifications to create the mapping.
- This mapping is used by the **Trained but not Certified** report to identify students who completed the ILT but haven't obtained the associated Certification(s).
- Changing the training type away from ILT automatically clears the certification mapping.
- During import, multiple certifications can be specified as comma-separated values in a single cell.

#### Legacy Certifications & Replacements

A **Certification** or **Accreditation** can be flagged as **Legacy** when it has been retired or superseded.

- On the **Full Title detail page**, tick **Mark this Full Title as Legacy** to retire every Certification/Accreditation under it at once. (Adding or editing a single Certification/Accreditation also exposes the same **Mark as Legacy** control.)
- Once legacy, a **Replaced by** picker of all other **Full Titles** that contain a Certification/Accreditation appears — select one or more. Multiple replacements are treated as **alternatives**: holding any one of them counts as having migrated (the same model as an ILT mapping to several certs). Leave it empty for a cert that was retired with no successor.
- A **Legacy** badge is shown on the training in the catalogue, on each learner's training list (with the replacement name), and on the training detail page. On **Admin > Training Data** the grouped row's badge is followed by an inline subtitle (`→ Replaced by: <names>` or `→ No replacement defined`) so you can audit replacements at a glance, and a **Show legacy only** toggle in the search bar scopes the list to retired Certs/Accreds.
- Changing the type away from Certification/Accreditation automatically clears the legacy flag and replacements.
- During import, set a **Legacy** column to `Yes` and list replacement training titles (comma-separated) in a **Replacement** column.
- The **Legacy Replacement Gap** report uses this to find learners still holding a legacy cert who haven't taken the replacement.

### Product Types

Navigate to **Admin > Product Types** to manage the list of product types used to categorise training data (shown on the dashboard's *By Product Type* chart and the *By Product Type* report).

- **Add / Rename** — Names must be unique (case-insensitive).
- **Colour** — Each product type can be given an optional brand colour (hex). Charts and reports that represent products will use that colour: the *By Product Type* and dashboard charts colour each product's X-axis label, while the *Comparison "By Product"* chart colours each product's series. Product types without a colour render in a neutral grey so it's obvious which still need configuring.
- **Delete** — Only possible when no training data references the product type. The **Trainings** column shows the current usage count; reassign those trainings first.
- **Import** — Upload a CSV or Excel file with a `Name` column (required) and an optional `Color` column (`#RRGGBB`) to bulk-create or recolour product types. The wizard auto-maps the columns and shows a preview; names that already exist (case-insensitive) are skipped, but a new colour on an existing row is applied as an update. Invalid colour values are logged and the row is imported without a colour.
- **Export** — Download the current list (including colour) as CSV, Excel, or PDF.
- During a training-data import, product-type cells are matched case-insensitively against this list. Unknown values are reported as per-row errors rather than being silently changed.

### User Management

Navigate to **Admin > Users** to manage user accounts.

**Features:**

- **Add User** — Create a new account with username, display name, password, and role (Admin or User).
- **Edit User** — Change display name or role. Cannot demote the last admin.
- **Reset Password** — Set a new password for any user.
- **Disable MFA** — Turn off multi-factor authentication for a user.
- **Delete User** — Remove a user account. Cannot delete yourself or the last admin.

### System Settings (SuperAdmin only)

**Admin → System Settings** controls instance-wide defaults that apply to every user who hasn't set a personal override.

- **Default Date Format** — `DD/MM/YYYY` or `MM/DD/YYYY`. Used for:
  - Parsing dates during CSV / Excel imports (the import flow detects format mismatches and prompts before committing — see **Import Data → Date Format Detection**).
  - Displaying dates throughout the app for users who haven't picked a personal preference.

Individual users override their display preference on the **My Account** page (Sidebar → username avatar → Display Date Format). The stored data is format-neutral; the format only affects parsing on input and rendering on output, so changing it is non-destructive and reversible.

### Backup & Restore

Navigate to **Admin > Backup** to create or restore full system backups.

#### Create Backup

Click **Download Backup** to generate and download a `.zip` file containing all system data. The backup includes:

| File | Contents |
|------|----------|
| `region_data.json` | All country/region mappings |
| `training_data.json` | All training program definitions |
| `students.json` | All student records |
| `training_taken.json` | All training completion records |
| `import_metadata.json` | Import timestamps |
| `users.json` | User accounts (with hashed passwords) |
| `backup_metadata.json` | Backup version and creation timestamp |

The downloaded file is named `training-tracker-backup-<timestamp>.zip`. When an `ENCRYPTION_KEY` is configured, the archive is encrypted with **this server's** key and saved as `.zip.enc`. A key-encrypted backup can **only** be restored on the same system (or another system configured with the identical `ENCRYPTION_KEY`).

#### Portable Backup (restore on a different system)

To move data to a **different** installation, click **Portable backup…** and choose a passphrase (at least 8 characters). The archive is encrypted with a key derived from that passphrase instead of the server's `ENCRYPTION_KEY`, so it can be restored anywhere by re-entering the same passphrase. The file is named `training-tracker-backup-<timestamp>.portable.zip.enc`.

> **Keep the passphrase safe — there is no way to recover the data if it is lost.**

#### Config Backup (seed a fresh system)

When you stand up a new Training Tracker instance and want to carry over the catalogue, regions, programs, and import aliases — but **not** any learner data — click **Config Backup** (standard, tied to `ENCRYPTION_KEY`) or **Portable config backup…** (passphrase-encrypted, restores anywhere). The file is saved as `training-tracker-config-<timestamp>.zip[.enc]`.

A config backup contains: product types, region data, the full training catalogue, OLX parent/sub-item relationships, specialisations, program data + alternatives, import aliases, and the system settings singleton. It explicitly excludes students, training-taken records, users, companies, scheduled exports, export credentials, and import metadata.

Restoring a config backup wipes and replaces only the included reference tables and **leaves student and training-taken rows untouched**, so it is safe to run on a populated system when you just need to refresh the catalogue. Archive type is auto-detected on upload via a `kind` flag in `backup_metadata.json`; the upload form is shared with the standard restore.

#### Restore from Backup

Click **Upload Backup File** and select a previously created backup file. If it is a **portable** backup, enter the passphrase it was created with in the **Portable backup passphrase** field (leave it blank for a standard backup). A confirmation dialog will appear — type `RESTORE` to proceed.

**What happens during restore:**

1. All existing data is deleted (regions, training data, students, training records, import metadata).
2. Data from the backup is inserted in the correct order to satisfy foreign key constraints.
3. All operations run inside a single database transaction — if any step fails, no changes are made.

**Important:** Restoring a backup **replaces all existing data**. Create a backup of the current system first if you need to preserve it.

#### Automatic Backups

Enable automatic backups to save backups to a local directory on a schedule:

- **Backup Location** — Configurable directory path with a folder browser GUI. Click **Browse** to navigate the filesystem and select or create a folder.
- **Retention** — Set how many backup copies to keep. When the count is exceeded, the oldest backups are automatically deleted.
- **Schedule** — Daily or weekly, at a configurable time.
- **Run Backup Now** — Immediately saves a backup without waiting for the schedule.

#### Saved Backups

Lists all backup zip files in the configured directory. You can:

- **Restore** — Click Restore on any saved backup to restore from it (type `RESTORE` to confirm).
- **Delete** — Remove individual backup files.

### Updates

Navigate to **Admin > Updates** to check for and apply application updates.

#### Check for Updates

Click **Check for Updates** to query GitHub for the latest release. If an update is available, the new version number, release name, date, and release notes are displayed.

#### Apply Update

Click **Update Now** to start the update. A progress bar shows the current step:

1. Checks for update availability
2. Pulls latest code from GitHub
3. Installs new/updated dependencies
4. Runs database migrations
5. Rebuilds the application
6. Restarts the service

On completion, a success message is shown with the new version. The progress panel pins to the top of the page while the update is running so it stays visible as you scroll, and the page warns you if you try to refresh the tab or click a sidebar link before the update completes (the update itself continues in the background, but leaving the page hides the progress indicator). Do not close the page during the update.

#### Rollback & Error Handling

Before starting an update, the system creates a backup of the current build output and database. If any step fails, the system automatically rolls back:

1. Restores git to the previous commit
2. Restores the previous `.next` build directory
3. Restores the database from the pre-update dump (if migrations ran)
4. Regenerates the Prisma client
5. Restarts the service with the previous version

A detailed timestamped log is available via the **Update Log** section on the Updates page.

#### Update Channels

The system supports two update channels, controlled by the `UPDATE_CHANNEL` variable in your `.env` file:

- **`stable`** (default) — Only shows full production releases. Recommended for production systems on the `master` branch.
- **`dev`** — Shows all releases including pre-releases. Use this for development/testing systems that track the `dev` branch.

The current channel is displayed as a clickable badge next to the version number on the Updates page. Click it to switch channels — the system will check out the target branch, pull the latest code, rebuild, and restart. When switching from dev back to stable, the system verifies that the latest stable release is at or ahead of your installed version to prevent downgrades.

#### Automatic Updates

Enable automatic updates to have the system check for and apply updates on a schedule. Options:

- **Frequency** — Daily or Weekly
- **Day** — Day of the week (weekly only)
- **Time** — Time of day to check and apply updates

The application restarts during automatic updates.

### Scheduled Report Exports

Navigate to **Admin > Scheduled Report Exports** to automate report delivery on a recurring schedule.

#### Adding a Schedule

Click **Add Schedule** and configure:

| Field | Description |
|-------|-------------|
| **Name** | A descriptive label for this schedule |
| **Report** | Which report to export (Trained but Not Certified, Legacy Replacement Gap, Learner Achievement Scorecard, By Product Type, By Function, Expiring Soon, Currently Expired, Achievement Over Time) |
| **Format** | CSV, Excel (XLSX), or PDF |
| **Destination** | Where to deliver the file |
| **Schedule** | Daily / Weekly / Monthly at a specified time |

#### Destinations

| Destination | Setup Required |
|-------------|----------------|
| **Local Filesystem** | Output path on the server; optional retention count |
| **Email** | Recipient address; SMTP credentials in Provider Credentials |
| **Google Drive** | Folder ID (optional); OAuth credentials connected via the wizard |
| **Box** | Folder ID (optional); OAuth credentials connected via the wizard |
| **OneDrive** | Folder path (optional); Azure app + delegated OAuth connected via the wizard |

#### Provider Credentials

> **⚠ Cloud providers such as Google, Box, & OneDrive require a business account and will not work with consumer accounts. You will also be required to expose the instance to the internet so that the OAuth process can complete.**

Expand the **Provider Credentials** section to manage authentication for each delivery provider.

- **Email (SMTP)** keeps an inline form (host, port, username, password, from address) plus a **Test Connection** button.
- **Google Drive**, **Box**, and **OneDrive** each have a **Connect with…** button that launches a guided OAuth wizard. Training Tracker:
  1. Shows the redirect URI you must register in the provider's developer console (with a Copy button).
  2. Walks you through registering an OAuth app in Google Cloud Console / Box Developer Console / Microsoft Entra.
  3. Opens a popup to the provider's consent screen and captures the resulting refresh token automatically.
  4. Runs a Test Connection so you can see who you're connected as.

The redirect URI is `https://<your-host>/api/admin/scheduled-exports/credentials/oauth/<provider>/callback`. If your install is behind a reverse proxy, ensure `X-Forwarded-Proto` and `X-Forwarded-Host` are forwarded to the app.

OneDrive uses the **delegated** OAuth flow: files are uploaded to the signed-in user's own OneDrive (`/me/drive`). For org-wide automation prefer a service account to sign in.

#### Credential Health Monitoring

Cloud refresh tokens have a finite lifetime — Box tokens expire 60 days after issue, OneDrive after about 90. A red/amber banner appears at the top of the **Dashboard** and the **Scheduled Exports** page when any credential has expired or is approaching expiry, with a one-click **Reconnect** link. The banner only shows for admins.

Each provider card also displays a status badge (`Healthy`, `Expires in N days`, `Expired`, `Auth failed`, `Not configured`) with the date of the last successful authentication.

A daily cron script keeps health status fresh:

```bash
# /etc/cron.d/training-tracker-credentials  (runs at 04:30 each day)
30 4 * * * www-data /opt/training-tracker/deploy/auto-credential-check.sh /opt/training-tracker
```

The script reads `CRON_SECRET` from `.env` and POSTs an HMAC-signed request to the credentials/check endpoint. Without it, health updates only happen when admins click Test Connection or when scheduled exports run.

#### Schedule Actions

Each scheduled export row supports four actions:

- **Run Now** (▶) — Immediately execute the export without waiting for the next scheduled time
- **Enable/Disable** (⏱) — Pause or resume without deleting
- **Edit** (✏) — Modify any setting
- **Delete** (🗑) — Permanently remove the schedule

The **Last Run** column shows the date/time of the last execution and a green ✓ (success) or red ⚠ (error) status. Hover over the error indicator to see the error message.

#### How Scheduling Works

A cron job running every minute on the server calls the execute endpoint, which checks all enabled schedules against the current time and runs any that are due. No configuration beyond saving a schedule is required.

---

### Data Clean-Up

Navigate to **Admin > Data Clean-Up** to scan for and fix data quality issues.

#### Student Data

Click **Scan for Issues** to check all student records for problems in the Full Name field:

| Issue | Description | Fix Applied |
|-------|-------------|-------------|
| **Spaces** | Leading or trailing whitespace | Trimmed |
| **Email as Name** | Full name is an email address | Derived from email local part (e.g. `jane.doe@co.com` → `Jane Doe`) |
| **Question Marks** | Full name contains only question marks and whitespace (e.g. `?`, `? ??`, `??? ??`) | Derived from email local part (e.g. `jane.doe@co.com` → `Jane Doe`) |
| **Duplicate Name** | Full name repeats the same word (e.g. `Jane Jane`) | Duplicates removed; if only one word remains, the name is derived from the email local part instead |
| **Numbers** | Digits in the name | Removed |
| **Special Characters** | Non-letter/space/hyphen/apostrophe chars | Removed |

Results are shown with issues highlighted inline. The **Suggested Fix** column is an editable field, so you can override the suggested name before applying it. By default no rows are selected after a scan — tick the rows you want to fix (or use the issue filter chips to bulk-select), then click **Fix Selected**.

#### Future Completion Dates

Click **Scan for Issues** under **Future Completion Dates** to list every training record whose `Completed Date` is later than today (server time). These are typically data-entry mistakes — a certification, accreditation, or ILT cannot be completed in the future, and a future date also pushes the auto-computed expiry (`completedDate + 2 years`) out by the same amount.

Each row's completed date is shown as an editable date input, highlighted in amber while it is still in the future. Pick the correct date and click **Save** on that row to commit the change. There is no automated fix — every correction is made manually, one row at a time. Saving recomputes the expiry to completed + 2 years and re-evaluates any OLX parent the row may belong to.

#### Wipe All Data

The **Danger Zone** at the bottom of the Data Clean-Up page offers two destructive actions. **Both cannot be undone.**

- **Wipe All Data (Keep Accounts)** — Permanently deletes all students, training records, training data, product types, region data, programs, companies, and scheduled exports, but **keeps your user accounts** so you stay signed in. Type `WIPE` to confirm.
- **Factory Reset (Wipe Everything)** — Deletes **everything, including all user accounts**, returning the system to its brand-new state. You are taken straight to the first-run setup wizard to create a new admin. Type `RESET` to confirm.

---

### Program Data

Navigate to **Admin > Program Data** to define partner program compliance requirements.

Each entry specifies a requirement within a program:

| Field | Description |
|-------|-------------|
| **Program Name** | The partner program name. Each unique name automatically gets its own dashboard under **Programs**. |
| **Specialisation** | The product or solution area for this requirement. Managed via a controlled dropdown — click **+** to add new specialisations. |
| **Level** | Whether the requirement applies at Country, Theatre, or Global level |
| **Type** | Certification, Accreditation, Instructor-Led Training, OLX, or OLX Sub-Item |
| **Training** | The specific training required (filtered by the selected Type) |
| **Quantity Required** | For Country/Theatre: number of people needed. For Global: number of compliant theatres needed. |

The page includes search, filtering by all fields, sorting, and export to CSV/Excel/PDF. Requirements can also be bulk-imported via the **Import** dialog, which accepts a CSV/Excel file by drag-and-drop onto the drop zone or by clicking to browse.

---

## Public API

Training Tracker exposes a **read-only public API** so trusted third-party
systems (CRMs, BI tools, partner portals) can pull data programmatically. Access
is controlled by **API keys**, each scoped to one or more companies.

### Issuing a key

In **Admin > API Keys** (SuperAdmin only):

1. Click **New API Key**, give it a descriptive name, and select the companies it may read.
2. Optionally set an expiry date (leave blank for a key that never expires).
3. The full key is shown **once**, right after creation — copy and store it securely. Only a hash is kept in the database, so a lost key cannot be recovered (delete it and issue a new one).

Keys can be **disabled** (temporarily), **revoked** (permanently), edited
(rename / change companies / adjust expiry) or deleted. The **Last used** column
helps you spot stale keys, and the **Last IP** column shows the source IP of the
most recent request (from `X-Forwarded-For`) so you can confirm traffic is
coming from where you expect.

### Calling the API

Send the key in an `Authorization: Bearer <key>` header (an `X-API-Key` header is
also accepted) over HTTPS:

```bash
curl -H "Authorization: Bearer tt_live_xxxxxxxx" \
  https://your-host/api/public/v1/students
```

| Endpoint | Returns |
|----------|---------|
| `GET /api/public/v1` | Index — confirms the key works and lists its companies and the available endpoints |
| `GET /api/public/v1/students` | Student roster (name, email, theatre, country, company) |
| `GET /api/public/v1/training-records` | Per-completion training records (latest per learner & training) |
| `GET /api/public/v1/reports/{reportType}` | Report aggregates — `trained-not-certified`, `legacy-gap`, `learner-scorecard`, `by-product`, `by-function`, `expiring-soon`, `currently-expired`, `last-12-months` |

All endpoints accept an optional `?companyId=` to narrow to a single granted
company; `training-records` also accepts `?theatre=`, `?region=`, `?country=`,
and `?activeOnly=true`. A request for a company the key cannot read returns no
rows.

### Security

- **Read-only by design** — there are no write endpoints under `/api/public`, so a leaked key can never modify data.
- **Company-scoped** — a key only ever sees data for its assigned companies.
- **Hashed at rest** — only a SHA-256 hash of the key is stored; the plaintext is shown once.
- **Rate-limited** — 120 requests per minute per key (excess requests get HTTP 429).
- **Revocable & expirable** — disable, revoke, or expire a key at any time.

Keys are best used server-to-server. Serve the app over HTTPS and never embed a
key in browser-side code.

---

## Partner Programs

Partner programs are **fully data-driven**. Every distinct program name configured in **Admin > Program Data** automatically gets its own compliance dashboard at **Programs > _[name]_** — no code changes are required to add a new program. The dashboard at `/programs/[programName]` auto-adapts to how the program is configured.

### Report sections

The dashboard shows only the sections relevant to the program's configured requirement levels:

| Section | Shown when | Filter | Shows |
|---------|-----------|--------|-------|
| **Country Report** | Program has Country-level requirements | Country dropdown | People per country with each required training vs. the requirement |
| **Region Report** | Program has Country-level requirements | Region dropdown | The same, aggregated across all countries in a region |
| **Theatre Report** | Program has Theatre-level requirements | Theatre dropdown | People per theatre with each required training vs. the requirement |
| **Global Report** | Program has Global-level requirements | None | See below |

The Country/Region/Theatre reports display specialisations as columns with grouped rows showing the training name, required count, and attained count. Attained values are colour-coded **green** (met) or **red** (not met). Click **View** on any attained cell to see the qualifying students.

### Global report — two presentations

The Global report auto-adapts based on the program's data:

- **Compliant-theatre count** — when Global rows have no specific training, the report shows how many theatres meet all of a specialisation's theatre-level requirements, against a target number of compliant theatres.
- **Global count with per-theatre minimums** — when a requirement has a **Minimum per Theatre** value, each specialisation appears as a card with a **Compliant** / **Not Compliant** badge and a global attained/required total. Click the chevron to expand a per-theatre breakdown. The requirement is only **Met** when the global total is reached **and** every theatre meets its minimum.

All sections support export to CSV, Excel, and PDF. Alternative trainings (OR logic) configured on a requirement count any qualifying training, deduplicated by student.

### Compliance as of — upcoming-expiry projection

A **Compliance as of** selector in the dashboard header lets you look ahead and see how upcoming certificate expiry will affect compliance. Pick **+3**, **+6**, or **+12 months** and every section recomputes compliance as it will stand on that future date — any certificate expiring within the window drops out of the counts (set it back to **Now** for today's snapshot).

- Attained figures display as **current → projected** (e.g. `5 → 3`), with a **▼N expiring** note showing how many people lose a qualifying certificate within the window.
- Requirements (and theatres) that are compliant today but will fall below their requirement by the chosen horizon are shaded **amber** with an **At Risk** status — an early warning to schedule renewals before compliance breaks. Green stays compliant through the horizon; red is already non-compliant today.
- Section exports gain **Projected**, **Expiring**, and **Projected Compliant** columns reflecting the selected horizon, and the file name carries a `-plusNmo` suffix.

---

## Data Model

### Training Types

| Type | Description |
|------|-------------|
| **Certification** | Formal certification exams |
| **Accreditation** | Accreditation programmes |
| **Instructor-Led Training** | Classroom or virtual instructor-led sessions |
| **OLX** | Online learning experience. Either a single online training or a parent that bundles multiple **OLX Sub-Items** &mdash; the parent counts as completed once a student finishes every sub-item. Like an ILT, an OLX can lead to one or more Certifications. |
| **OLX Sub-Item** | A component of a parent OLX. Sub-items can be shared across multiple parents. Imports flag a row as a sub-item by populating the **Parent Training Title** column (comma-separated for multi-parent membership). |

### Product Types

Product types are an admin-managed list (not a fixed set), maintained in **Admin > Product Types**. Add, rename, or remove the product types that fit your catalogue; each training is assigned one. Product types in use by training data cannot be deleted until those trainings are reassigned.

### Function Types

Sales, Pre-Sales, Deployments

### Expiry

All training completions have an automatically calculated expiry date. The Dashboard shows how many are expiring within 1, 3, and 6 months.

---

## Exporting Data

Export functionality is available on the following pages:

| Page | What is exported |
|------|-----------------|
| **Admin > Region Data** | Country and Region |
| **Admin > Training Data** | Training Title, Full Title, Type, Product, Function, Link, Certification, Parent Training Title, Legacy, Replacement |
| **Reports** | Full report results with all columns |

Each export supports three formats:

- **CSV** — Comma-separated values, compatible with any spreadsheet application.
- **Excel** — `.xlsx` format for Microsoft Excel.
- **PDF** — Formatted table document. Automatically switches to landscape orientation when there are more than 5 columns.

Click the **Export** button and select the desired format. For reports, the export respects any active filters — only the currently displayed results are exported.
