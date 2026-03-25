# Training Tracker

A full-stack application for tracking student certifications, accreditations, and instructor-led training programs across product lines and business functions.

Built with Next.js, React, PostgreSQL, and Prisma.

---

## Table of Contents

- [Getting Started](#getting-started)
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
  - [Wipe Data](#wipe-data)
- [Data Model](#data-model)
- [Exporting Data](#exporting-data)

---

## Getting Started

The `deploy/` directory contains scripts for installing and updating Training Tracker on a Debian-based Linux server or LXC container. Both scripts should be run as **root**.

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
6. **Creates the `.env` file** with the database connection string (only if `.env` doesn't already exist).
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

---

## Dashboard

The Dashboard is the default landing page and provides an at-a-glance overview of all training activity.

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

### Data Clean-Up

Navigate to **Admin > Data Clean-Up** to scan for and fix data quality issues.

#### Student Data

Click **Scan for Issues** to check all student records for problems in the Full Name field:

| Issue | Description | Fix Applied |
|-------|-------------|-------------|
| **Spaces** | Leading or trailing whitespace | Trimmed |
| **Email as Name** | Full name is an email address | Derived from email local part (e.g. `jane.doe@co.com` → `Jane Doe`) |
| **Numbers** | Digits in the name | Removed |
| **Special Characters** | Non-letter/space/hyphen/apostrophe chars | Removed |

Results are shown with issues highlighted inline. Use the checkboxes to select records, then click **Fix Selected** to apply corrections.

#### Wipe All Data

The **Danger Zone** at the bottom of the Data Clean-Up page allows you to permanently delete all students, training records, training data, and region data. Type `WIPE` to confirm. **This cannot be undone.**

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
