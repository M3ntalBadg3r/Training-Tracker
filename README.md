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
  - [Scheduled Exports](#scheduled-exports)
  - [Program Data](#program-data)
  - [Wipe Data](#wipe-data)
- [Partner Programs](#partner-programs)
  - [APS Dashboard](#aps-dashboard)
  - [Global Diamond Dashboard](#global-diamond-dashboard)
- [Data Model](#data-model)
- [Exporting Data](#exporting-data)

---

## Getting Started

The `deploy/` directory contains scripts for installing and updating Training Tracker on a Debian-based Linux server or LXC container. Both scripts should be run as **root**.

### Quick Install (curl)

Install Training Tracker on a fresh Debian-based system with a single command:

```bash
curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash
```

To install the **dev channel** (tracks the `dev` branch and receives pre-releases):

```bash
curl -sSL https://raw.githubusercontent.com/M3ntalBadg3r/Training-Tracker/master/deploy/install-remote.sh | bash -s -- --dev
```

This downloads the repository, installs all dependencies, sets up the database, and starts the application. Must be run as **root**.

### Installation Script

The installation script (`deploy/install.sh`) performs a complete, automated setup from a fresh Debian-based system. Run it from the project root:

```bash
bash deploy/install.sh
```

**What it does (9 steps):**

1. **Updates system packages** via `apt-get update`.
2. **Installs Node.js 22 LTS** from the NodeSource repository.
3. **Installs PostgreSQL** (if not already installed) and starts the service.
4. **Creates the database and user** — database `training_tracker`, user `tracker`.
5. **Copies application files** to `/opt/training-tracker` (skipped if already running from that directory).
6. **Configures the `.env` file** — creates it with `DATABASE_URL` and `JWT_SECRET` if missing, or appends any missing required variables to an existing `.env` file.
7. **Installs npm dependencies**, runs Prisma migrations, generates the Prisma client, and builds the application.
8. **Installs a systemd service** (`training-tracker.service`) so the application starts automatically on boot. Falls back to an init.d script if systemd is not available.
9. **Prints the URL** where the application is accessible (port 3000).

**Default database credentials:**

| Setting | Value |
|---------|-------|
| Database | `training_tracker` |
| User | `tracker` |
| Password | `tracker123` |

To use different credentials, edit the variables at the top of `deploy/install.sh` before running it, or edit `/opt/training-tracker/.env` after installation and restart the service.

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

---

## Authentication & Users

Training Tracker requires authentication to access. On first launch (when no users exist), a setup wizard guides you through creating the initial administrator account.

### Roles

| Role | Access |
|------|--------|
| **Admin** | Full access to all pages and features, including admin functions (import, backup, wipe, user management) |
| **User** | Read-only access to Dashboard, Students, Training, and Reports. No access to admin pages or edit/delete actions. |

### Login

Navigate to any page and you will be redirected to the login screen. Enter your username and password. If MFA is enabled on your account, you will be prompted for a 6-digit code from your authenticator app.

### My Account

Click **My Account** in the sidebar to view your profile and manage MFA settings.

### Multi-Factor Authentication (MFA)

Any user can enable TOTP-based MFA from **My Account**. Click **Enable MFA**, scan the QR code with your authenticator app (Google Authenticator, Authy, Microsoft Authenticator, etc.), and enter the verification code. Once enabled, login requires a 6-digit code from your authenticator app. You can disable MFA from the same page (requires your password). Admins can also disable MFA for any user via **Admin > Users**.

### First-Run Setup

On a fresh installation with no users in the database, all routes redirect to `/setup`. Fill in a username, display name, and password to create the first Admin account, then log in normally.

### Environment Variables

The `.env` file requires:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret key for JWT token signing (minimum 32 characters recommended) |
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

### Night Mode

Click the **Moon** icon in the sidebar to toggle night (dark) mode. Click the **Sun** icon to switch back to light mode. Your preference is saved in the browser and persists across sessions.

### Theatre Filter

Use the **Theatre** dropdown in the top-right corner to filter all metrics and charts by theatre. Options include **Global** (all theatres) plus any theatres found in your student data (e.g., EMEA, NAM, LATAM, JAPAC). Previously selected theatres are cached for instant switching.

### Metric Cards

Four summary cards are displayed at the top:

| Metric | Description |
|--------|-------------|
| **Total Students** | Number of students in the system |
| **Certifications Earned** | Total certification completions across all students |
| **Accreditations Earned** | Total accreditation completions across all students |
| **Instructor-Led Trainings** | Total ILT completions across all students |

### Charts

| Chart | Type | Description |
|-------|------|-------------|
| **By Product Type** | Bar chart | Breakdown of Certifications, Accreditations, and ILT by product (Cortex, SASE, Cloud, Strata, Foundation) |
| **By Function** | Bar chart | Breakdown by function (Sales, Pre-Sales, Deployments) |
| **Expiring Soon** | Bar chart | Number of trainings expiring within 1, 3, and 6 months |
| **Achieved Over Last 12 Months** | Line chart | Monthly trend of completions over the past year |

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

Click **View** on any row to open the student's detailed record.

### Student Detail

The student detail page shows:

- **Contact Information** — Full Name, Email, Theatre, Country, and Region. Click **Edit** to modify these fields. Changes are previewed in a confirmation modal before saving.
- **Training Records** — A table of all trainings completed by the student, including Title (with link if available), Type, Product, Function, Completed Date, and Active status. Individual training records can be removed in edit mode.

---

## Training Catalog

Navigate to **Training** in the sidebar to browse all available training programs.

The table displays:

- Full Title
- Training Type (Certification, Accreditation, or Instructor-Led Training)
- Product Type
- Function
- Link (if available)
- Students Taken (count of unique students who completed this training)

Click **View Students** on any row to see which students have completed that training.

---

## Import Data

Navigate to **Import** in the sidebar to bulk-import student training records from CSV or Excel files.

### Import Workflow

1. **Upload** — Drag and drop or click to select a `.csv`, `.xls`, or `.xlsx` file.
2. **Column Mapping** — The system auto-maps columns where possible. Manually adjust any unmatched columns. Required fields are:
   - Full Name
   - Email Address
   - Theatre
   - Country
   - Training Title
   - Completed Date
3. **Processing** — The system imports the data, creating students and training records as needed.
4. **Summary** — A summary shows counts of students created/updated, trainings imported/skipped, and any errors.

### Data Cleansing (Automatic)

During import, the following cleansing rules are applied automatically:

- **Email** — Converted to lowercase.
- **Full Name** — Leading/trailing spaces are removed and each word is capitalised (e.g. `jOHN sMITH` becomes `John Smith`).
- **Empty Full Name** — If the Full Name field is blank, the system looks at the email address. If the local part (before the `@`) contains two words separated by a full stop (e.g. `jane.doe@company.com`), it uses those as the name (`Jane Doe`). Otherwise, the full email address is used as the name.

---

## Reports

Navigate to **Reports** in the sidebar. Reports are presented as collapsible sections, each with their own filters and export options. Clicking a dashboard chart navigates directly to the corresponding report.

### By Product Type

Detailed listing of all training records, filterable by product type, training type, and theatre. This is the report behind the **By Product Type** dashboard chart.

### By Function

Detailed listing of all training records, filterable by function, training type, and theatre. This is the report behind the **By Function** dashboard chart.

### Expiring Soon

Shows training records expiring within a selectable time window (1, 3, or 6 months). Filterable by training type and theatre. This is the report behind the **Expiring Soon** dashboard chart.

### Achieved Over Last 12 Months

Shows all training records completed in the last 12 months, filterable by training type and theatre. This is the report behind the **Achieved Over Last 12 Months** dashboard chart.

### Trained But Not Certified

This report identifies students who have completed an **Instructor-Led Training** but have **not** obtained the associated **Certification**.

The association is determined by the certification mapping configured in **Admin > Training Data** (see [Training Data](#training-data)).

**Columns displayed:**

- Full Name
- Email Address
- Theatre
- Region
- Country
- Instructor-Led Training (shown as Full Title)
- Certification Not Obtained (shown as Full Title)

**Filtering:**

- Search by name or email
- Filter by Theatre, Region, Country, Training, or Certification

**Export:**

- Export filtered results as CSV or Excel

---

## Admin

Navigate to **Admin** in the sidebar to access administrative functions. The Admin page provides links to sub-pages and a Danger Zone for data management.

### Region Data

Manage the mapping between countries and regions.

**Features:**

- **View** — Table of all countries and their assigned regions.
- **Search** — Filter by country name.
- **Filter** — Filter by region.
- **Add** — Add a new country/region mapping using the input row at the bottom of the table.
- **Edit** — Click **Edit** on any row to modify the country or region inline, then **Save** or **Cancel**.
- **Delete** — Remove a country/region mapping.
- **Import** — Upload a CSV or Excel file with `Country` and `Region` columns. The system auto-maps columns and shows a preview before importing.
- **Export** — Download all region data as CSV or Excel.

### Training Data

Manage the definitions of all training programs in the system.

**Columns:**

| Column | Description |
|--------|-------------|
| **Training Title** | Short identifier used internally and during import matching |
| **Full Title** | Display name shown to users |
| **Type** | Certification, Accreditation, or Instructor-Led Training |
| **Product** | Cortex, SASE, Cloud, Strata, or Foundation |
| **Function** | Sales, Pre-Sales, or Deployments |
| **Link** | Optional URL to training resources |
| **Certification** | Certification mapping (ILT only — see below) |

**Features:**

- **Add Training** — Click **Add Training** to open a modal form for creating a new training entry.
- **Edit** — Click **Edit** on any row to modify fields inline.
- **Delete** — Remove a training entry.
- **Search** — Search by training title or full title.
- **Filter** — Filter by Full Title, Type, Product, or Function.
- **Import** — Upload a CSV or Excel file. Columns can be mapped to all fields including Certification. The system supports common aliases for type values (e.g. `ILT`, `cert`, `pre-sales`).
- **Export** — Download all training data as CSV or Excel.

#### Certification Mapping

The **Certification** column is only available for trainings of type **Instructor-Led Training**. It allows you to map an ILT to one or more Certifications that it leads to.

- When editing or adding an ILT, a checkbox list of all available Certifications is shown.
- Select one or more Certifications to create the mapping.
- This mapping is used by the **Trained but not Certified** report to identify students who completed the ILT but haven't obtained the associated Certification(s).
- Changing the training type away from ILT automatically clears the certification mapping.
- During import, multiple certifications can be specified as comma-separated values in a single cell.

### User Management

Navigate to **Admin > Users** to manage user accounts.

**Features:**

- **Add User** — Create a new account with username, display name, password, and role (Admin or User).
- **Edit User** — Change display name or role. Cannot demote the last admin.
- **Reset Password** — Set a new password for any user.
- **Disable MFA** — Turn off multi-factor authentication for a user.
- **Delete User** — Remove a user account. Cannot delete yourself or the last admin.

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

The downloaded file is named `training-tracker-backup-<timestamp>.zip`.

#### Restore from Backup

Click **Upload Backup File** and select a previously created backup `.zip` file. A confirmation dialog will appear — type `RESTORE` to proceed.

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

On completion, a success message is shown with the new version. Do not close the page during the update.

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

### Scheduled Exports

Navigate to **Admin > Scheduled Exports** to automate report delivery on a recurring schedule.

#### Adding a Schedule

Click **Add Schedule** and configure:

| Field | Description |
|-------|-------------|
| **Name** | A descriptive label for this schedule |
| **Report** | Which report to export (Trained but Not Certified, By Product Type, By Function, Expiring Soon, Achieved in Last 12 Months) |
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
| **Question Marks** | Full name contains only question marks and whitespace (e.g. `?`, `? ??`, `??? ??`) | Derived from email local part (e.g. `karol.postol@co.com` → `Karol Postol`) |
| **Duplicate Name** | Full name repeats the same word (e.g. `Karol Karol`) | Duplicates removed; if only one word remains, the name is derived from the email local part instead |
| **Numbers** | Digits in the name | Removed |
| **Special Characters** | Non-letter/space/hyphen/apostrophe chars | Removed |

Results are shown with issues highlighted inline. The **Suggested Fix** column is an editable field, so you can override the suggested name before applying it. By default no rows are selected after a scan — tick the rows you want to fix (or use the issue filter chips to bulk-select), then click **Fix Selected**.

#### Wipe All Data

The **Danger Zone** at the bottom of the Data Clean-Up page allows you to permanently delete all students, training records, training data, and region data. Type `WIPE` to confirm. **This cannot be undone.**

---

### Program Data

Navigate to **Admin > Program Data** to define partner program compliance requirements.

Each entry specifies a requirement within a program:

| Field | Description |
|-------|-------------|
| **Program Name** | The partner program (e.g., "Authorized Professional Services (APS)") |
| **Specialisation** | The product specialisation (e.g., "Cortex XDR", "Prisma Access"). Managed via a controlled dropdown — click **+** to add new specialisations. |
| **Level** | Whether the requirement applies at Country, Theatre, or Global level |
| **Type** | Certification, Accreditation, or Instructor-Led Training |
| **Training** | The specific training required (filtered by the selected Type) |
| **Quantity Required** | For Country/Theatre: number of people needed. For Global: number of compliant theatres needed. |

The page includes search, filtering by all fields, sorting, and export to CSV/Excel/PDF.

---

## Partner Programs

### APS Dashboard

Navigate to **Programs > APS** to view compliance for the Authorized Professional Services program.

Three report views are available:

| Report | Filter | Shows |
|--------|--------|-------|
| **Country Report** | Country dropdown | Number of people per country with each required training vs. the requirement |
| **Theatre Report** | Theatre dropdown | Number of people per theatre with each required training vs. the requirement |
| **Global Report** | None | Number of compliant theatres vs. the global requirement |

Each report displays specialisations as columns with grouped rows showing the training name, required count, and attained count. Attained values are colour-coded: **green** if the requirement is met, **red** if not. In the Country and Theatre reports, click **View** on any attained cell to see the list of qualifying students. All reports support export to CSV, Excel, and PDF.

### Global Diamond Dashboard

Navigate to **Programs > Global Diamond** to view compliance for the Global Diamond partner program.

All requirements are evaluated globally — there are no country or theatre selectors. Each specialisation is displayed as a card with a **Compliant** / **Not Compliant** badge. Inside each card, a table lists the training requirements with:

| Column | Description |
|--------|-------------|
| **Training** | Training title and type |
| **Required (Global)** | Total number of certified people needed globally |
| **Attained** | Distinct active certifications held globally |
| **Min/Theatre** | Minimum required per theatre (if applicable) |
| **Status** | Met or Not Met |

When a requirement has a per-theatre minimum, click the chevron icon to expand a per-theatre breakdown showing each theatre's count and compliance. A requirement is only **Met** if the global total is reached **and** all theatres meet their per-theatre minimum.

Export the full compliance data (including theatre breakdowns) as CSV, Excel, or PDF using the Export button.

Requirements are configured in **Admin > Program Data** using program name **Global Diamond**, level **Global**, with an optional **Minimum per Theatre** value.

---

## Data Model

### Training Types

| Type | Description |
|------|-------------|
| **Certification** | Formal certification exams |
| **Accreditation** | Accreditation programmes |
| **Instructor-Led Training** | Classroom or virtual instructor-led sessions |

### Product Types

Cortex, SASE, Cloud, Strata, Foundation

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
| **Admin > Training Data** | Training Title, Full Title, Type, Product, Function, Link, Certification |
| **Reports** | Full report results with all columns |

Each export supports three formats:

- **CSV** — Comma-separated values, compatible with any spreadsheet application.
- **Excel** — `.xlsx` format for Microsoft Excel.
- **PDF** — Formatted table document. Automatically switches to landscape orientation when there are more than 5 columns.

Click the **Export** button and select the desired format. For reports, the export respects any active filters — only the currently displayed results are exported.
