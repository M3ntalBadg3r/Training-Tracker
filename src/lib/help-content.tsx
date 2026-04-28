import React from "react";

export interface HelpSection {
  title: string;
  content: React.ReactNode;
}

const helpSections: Record<string, HelpSection> = {
  dashboard: {
    title: "Dashboard",
    content: (
      <>
        <p>
          The Dashboard is the default landing page and provides an at-a-glance
          overview of all training activity.
        </p>

        <h3>Metric Cards</h3>
        <p>Four summary cards are displayed at the top:</p>
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Total Students</strong></td>
              <td>Number of students in the system</td>
            </tr>
            <tr>
              <td><strong>Certifications Earned</strong></td>
              <td>Total certification completions across all students</td>
            </tr>
            <tr>
              <td><strong>Accreditations Earned</strong></td>
              <td>Total accreditation completions across all students</td>
            </tr>
            <tr>
              <td><strong>Instructor-Led Trainings</strong></td>
              <td>Total ILT completions across all students</td>
            </tr>
          </tbody>
        </table>

        <h3>Night Mode</h3>
        <p>
          Click the <strong>Moon</strong> icon in the sidebar to switch to night
          (dark) mode. Click the <strong>Sun</strong> icon to switch back. Your
          preference is saved and persists across sessions.
        </p>

        <h3>Theatre Filter</h3>
        <p>
          Use the <strong>Theatre</strong> dropdown in the top-right corner to filter
          all metrics and charts by theatre. Options include <em>Global</em> (all
          theatres) plus any theatres found in your student data (e.g., EMEA, NAM,
          LATAM, JAPAC). Previously selected theatres are cached for instant switching.
        </p>

        <h3>Charts</h3>
        <p>
          Each chart is clickable &mdash; click any chart to navigate to the
          corresponding detailed report in the <strong>Reports</strong> section.
        </p>
        <table>
          <thead>
            <tr>
              <th>Chart</th>
              <th>Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>By Product Type</strong></td>
              <td>Bar chart</td>
              <td>
                Breakdown of Certifications, Accreditations, and ILT by product
                (Cortex, SASE, Cloud, Strata, Foundation)
              </td>
            </tr>
            <tr>
              <td><strong>By Function</strong></td>
              <td>Bar chart</td>
              <td>Breakdown by function (Sales, Pre-Sales, Deployments)</td>
            </tr>
            <tr>
              <td><strong>Expiring Soon</strong></td>
              <td>Bar chart</td>
              <td>
                Number of trainings expiring within 1, 3, and 6 months
              </td>
            </tr>
            <tr>
              <td><strong>Achieved Over Last 12 Months</strong></td>
              <td>Line chart</td>
              <td>Monthly trend of completions over the past year</td>
            </tr>
          </tbody>
        </table>
      </>
    ),
  },

  students: {
    title: "Students",
    content: (
      <>
        <p>
          View all students in a table with columns: Full Name, Email, Theatre,
          Region, and Country.
        </p>
        <p>
          Click <strong>View</strong> on any row to open the student&apos;s
          detailed record.
        </p>
      </>
    ),
  },

  "student-detail": {
    title: "Student Detail",
    content: (
      <>
        <p>The student detail page shows:</p>
        <ul>
          <li>
            <strong>Contact Information</strong> &mdash; Full Name, Email,
            Theatre, Country, and Region. Click <strong>Edit</strong> to modify
            these fields. Changes are previewed in a confirmation modal before
            saving.
          </li>
          <li>
            <strong>Training Records</strong> &mdash; A table of all trainings
            completed by the student, including Title (with link if available),
            Type, Product, Function, Completed Date, and Active status.
            Individual training records can be removed in edit mode.
          </li>
        </ul>
      </>
    ),
  },

  training: {
    title: "Training Catalog",
    content: (
      <>
        <p>Browse all available training programs. The table displays:</p>
        <ul>
          <li>Full Title</li>
          <li>
            Training Type (Certification, Accreditation, or Instructor-Led
            Training)
          </li>
          <li>Product Type</li>
          <li>Function</li>
          <li>Link (if available)</li>
          <li>
            Students Taken (count of unique students who completed this
            training)
          </li>
        </ul>
        <p>
          Use the <strong>Theatre</strong>, <strong>Region</strong>, and{" "}
          <strong>Country</strong> dropdowns above the table to filter trainings
          by student location. When filters are active, the Students Taken count
          reflects only students matching the selected filters, and trainings
          with no matching students are hidden.
        </p>
        <p>
          Click <strong>View Students</strong> on any row to see which students
          have completed that training.
        </p>
      </>
    ),
  },

  "training-detail": {
    title: "Training Detail",
    content: (
      <>
        <p>
          View which students have completed this training. The table shows each
          student&apos;s name, email, theatre, country, and whether the training
          is still active.
        </p>
        <p>
          Click <strong>View</strong> on any row to open that student&apos;s
          detailed record.
        </p>
        <p>
          Use the <strong>Export</strong> button to download the student list as
          CSV, Excel, or PDF.
        </p>
      </>
    ),
  },

  import: {
    title: "Import Data",
    content: (
      <>
        <p>
          Bulk-import student training records from CSV or Excel files.
        </p>

        <h3>Import Workflow</h3>
        <ol>
          <li>
            <strong>Upload</strong> &mdash; Drag and drop or click to select a{" "}
            <code>.csv</code>, <code>.xls</code>, or <code>.xlsx</code> file.
          </li>
          <li>
            <strong>Column Mapping</strong> &mdash; The system auto-maps columns
            where possible. Manually adjust any unmatched columns. Required
            fields are: Full Name, Email Address, Theatre, Country, Training
            Title, and Completed Date.
          </li>
          <li>
            <strong>Processing</strong> &mdash; The system imports the data,
            creating students and training records as needed.
          </li>
          <li>
            <strong>Summary</strong> &mdash; A summary shows counts of students
            created/updated, trainings imported/skipped, and any errors.
          </li>
        </ol>

        <h3>Data Cleansing (Automatic)</h3>
        <p>
          During import, the following cleansing rules are applied
          automatically:
        </p>
        <ul>
          <li>
            <strong>Email</strong> &mdash; Converted to lowercase.
          </li>
          <li>
            <strong>Full Name</strong> &mdash; Leading/trailing spaces are
            removed and each word is capitalised (e.g.{" "}
            <code>jOHN sMITH</code> becomes <code>John Smith</code>).
          </li>
          <li>
            <strong>Empty Full Name</strong> &mdash; If the Full Name field is
            blank, the system looks at the email address. If the local part
            (before the @) contains two words separated by a full stop (e.g.{" "}
            <code>jane.doe@company.com</code>), it uses those as the name (
            <code>Jane Doe</code>). Otherwise, the full email address is used as
            the name.
          </li>
        </ul>
      </>
    ),
  },

  reports: {
    title: "Reports",
    content: (
      <>
        <p>
          The Reports section contains five individual report pages, each
          accessible from the sidebar or the Reports landing page. Dashboard
          chart cards link directly to the relevant report page. Every report
          has its own filters and export options (CSV, Excel, PDF).
        </p>

        <h3>By Product Type</h3>
        <p>
          Detailed listing of all training records, filterable by product type,
          training type, and theatre. Clicking the <strong>By Product
          Type</strong> chart on the dashboard opens this report.
        </p>

        <h3>By Function</h3>
        <p>
          Detailed listing of all training records, filterable by function,
          training type, and theatre. Clicking the <strong>By Function</strong>{" "}
          chart on the dashboard opens this report.
        </p>

        <h3>Expiring Soon</h3>
        <p>
          Shows training records expiring within a selectable time window (1, 3,
          or 6 months). Filterable by training type and theatre. Clicking the{" "}
          <strong>Expiring Soon</strong> chart on the dashboard opens this
          report.
        </p>

        <h3>Last 12 Months</h3>
        <p>
          Shows all training records completed in the last 12 months, filterable
          by training type and theatre. Clicking the{" "}
          <strong>Achieved Over Last 12 Months</strong> chart on the dashboard
          opens this report.
        </p>

        <h3>Trained But Not Certified</h3>
        <p>
          Identifies students who completed an{" "}
          <strong>Instructor-Led Training</strong> but have <strong>not</strong>{" "}
          obtained the associated <strong>Certification</strong>. The
          association is determined by the certification mapping configured in{" "}
          <strong>Admin &gt; Training Data</strong>.
        </p>

        <h4>Navigation</h4>
        <p>
          In the sidebar, <strong>Reports</strong> expands to show all five
          sub-pages. In collapsed sidebar mode, clicking the Reports icon
          navigates to the Reports landing page.
        </p>

        <h4>Export</h4>
        <p>Each report page has an Export button to download results as CSV, Excel, or PDF.</p>
      </>
    ),
  },

  admin: {
    title: "Admin",
    content: (
      <>
        <p>
          The Admin page provides links to administrative sub-pages.
        </p>
        <ul>
          <li>
            <strong>Region Data</strong> &mdash; Manage the mapping between
            countries and regions.
          </li>
          <li>
            <strong>Training Data</strong> &mdash; Manage training program
            definitions.
          </li>
          <li>
            <strong>Backup &amp; Restore</strong> &mdash; Create and restore
            full system backups.
          </li>
          <li>
            <strong>User Management</strong> &mdash; Manage user accounts,
            roles, and multi-factor authentication.
          </li>
          <li>
            <strong>Data Clean-Up</strong> &mdash; Scan and fix data quality
            issues, and manage the Wipe All Data function.
          </li>
        </ul>
      </>
    ),
  },

  "data-cleanup": {
    title: "Data Clean-Up",
    content: (
      <>
        <p>
          Scan your data for quality issues and apply bulk fixes. Additional
          clean-up categories will be added over time.
        </p>

        <h3>Student Data</h3>
        <p>
          Click <strong>Scan for Issues</strong> to check all student records.
          The scanner detects the following issues in the Full Name field:
        </p>
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Description</th>
              <th>Fix Applied</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Spaces</strong></td>
              <td>Leading or trailing whitespace</td>
              <td>Trimmed</td>
            </tr>
            <tr>
              <td><strong>Email as Name</strong></td>
              <td>Full name is an email address</td>
              <td>Derived from email local part (e.g. jane.doe@co.com &rarr; Jane Doe)</td>
            </tr>
            <tr>
              <td><strong>Numbers</strong></td>
              <td>Digits in the name</td>
              <td>Removed</td>
            </tr>
            <tr>
              <td><strong>Special Characters</strong></td>
              <td>Characters other than letters, spaces, hyphens, apostrophes, or periods</td>
              <td>Removed</td>
            </tr>
          </tbody>
        </table>
        <p>
          Results are shown in a table with the issues highlighted inline. Use
          the checkboxes to select which records to fix, then click{" "}
          <strong>Fix Selected</strong>. A suggested fix is shown for each
          record before you apply it.
        </p>

        <h3>Wipe All Data</h3>
        <p>
          The <strong>Danger Zone</strong> at the bottom of this page allows you
          to permanently delete all students, training records, training data,
          and region data. Type <code>WIPE</code> to confirm.{" "}
          <strong>This cannot be undone.</strong>
        </p>
      </>
    ),
  },

  "region-data": {
    title: "Region Data",
    content: (
      <>
        <p>Manage the mapping between countries and regions.</p>

        <h3>Features</h3>
        <ul>
          <li>
            <strong>View</strong> &mdash; Table of all countries and their
            assigned regions.
          </li>
          <li>
            <strong>Search</strong> &mdash; Filter by country name.
          </li>
          <li>
            <strong>Filter</strong> &mdash; Filter by region.
          </li>
          <li>
            <strong>Add</strong> &mdash; Add a new country/region mapping using
            the input row at the bottom of the table.
          </li>
          <li>
            <strong>Edit</strong> &mdash; Click <strong>Edit</strong> on any row
            to modify the country or region inline, then{" "}
            <strong>Save</strong> or <strong>Cancel</strong>.
          </li>
          <li>
            <strong>Delete</strong> &mdash; Remove a country/region mapping.
          </li>
          <li>
            <strong>Import</strong> &mdash; Upload a CSV or Excel file with{" "}
            <code>Country</code> and <code>Region</code> columns. The system
            auto-maps columns and shows a preview before importing.
          </li>
          <li>
            <strong>Export</strong> &mdash; Download all region data as CSV,
            Excel, or PDF.
          </li>
        </ul>
      </>
    ),
  },

  "training-data": {
    title: "Training Data",
    content: (
      <>
        <p>Manage the definitions of all training programs in the system.</p>

        <h3>Columns</h3>
        <table>
          <thead>
            <tr>
              <th>Column</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Training Title</strong></td>
              <td>Short identifier used internally and during import matching</td>
            </tr>
            <tr>
              <td><strong>Full Title</strong></td>
              <td>Display name shown to users</td>
            </tr>
            <tr>
              <td><strong>Type</strong></td>
              <td>Certification, Accreditation, or Instructor-Led Training</td>
            </tr>
            <tr>
              <td><strong>Product</strong></td>
              <td>Cortex, SASE, Cloud, Strata, or Foundation</td>
            </tr>
            <tr>
              <td><strong>Function</strong></td>
              <td>Sales, Pre-Sales, or Deployments</td>
            </tr>
            <tr>
              <td><strong>Link</strong></td>
              <td>Optional URL to training resources</td>
            </tr>
            <tr>
              <td><strong>Certification</strong></td>
              <td>Certification mapping (ILT only)</td>
            </tr>
          </tbody>
        </table>

        <h3>Features</h3>
        <ul>
          <li>
            <strong>Add Training</strong> &mdash; Click{" "}
            <strong>Add Training</strong> to open a modal form for creating a
            new training entry.
          </li>
          <li>
            <strong>Edit</strong> &mdash; Click <strong>Edit</strong> on any row
            to modify fields inline.
          </li>
          <li>
            <strong>Delete</strong> &mdash; Remove a training entry.
          </li>
          <li>
            <strong>Search</strong> &mdash; Search by training title or full
            title.
          </li>
          <li>
            <strong>Filter</strong> &mdash; Filter by Full Title, Type, Product,
            or Function.
          </li>
          <li>
            <strong>Import</strong> &mdash; Upload a CSV or Excel file. Columns
            can be mapped to all fields including Certification. The system
            supports common aliases for type values (e.g. <code>ILT</code>,{" "}
            <code>cert</code>, <code>pre-sales</code>).
          </li>
          <li>
            <strong>Export</strong> &mdash; Download all training data as CSV,
            Excel, or PDF.
          </li>
        </ul>

        <h3>Certification Mapping</h3>
        <p>
          The <strong>Certification</strong> column is only available for
          trainings of type <strong>Instructor-Led Training</strong>. It allows
          you to map an ILT to one or more Certifications that it leads to.
        </p>
        <ul>
          <li>
            When editing or adding an ILT, a checkbox list of all available
            Certifications is shown.
          </li>
          <li>
            Select one or more Certifications to create the mapping.
          </li>
          <li>
            This mapping is used by the <strong>Trained but not Certified</strong>{" "}
            report to identify students who completed the ILT but haven&apos;t
            obtained the associated Certification(s).
          </li>
          <li>
            Changing the training type away from ILT automatically clears the
            certification mapping.
          </li>
          <li>
            During import, multiple certifications can be specified as
            comma-separated values in a single cell.
          </li>
        </ul>
      </>
    ),
  },

  "user-management": {
    title: "User Management",
    content: (
      <>
        <p>
          Manage user accounts for the Training Tracker system. Only
          administrators can access this page.
        </p>

        <h3>Roles</h3>
        <table>
          <thead>
            <tr>
              <th>Role</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Admin</strong></td>
              <td>Full access to all pages and features, including admin functions</td>
            </tr>
            <tr>
              <td><strong>User</strong></td>
              <td>Read-only access to Dashboard, Students, Training, and Reports. No access to admin pages or edit/delete actions.</td>
            </tr>
          </tbody>
        </table>

        <h3>Features</h3>
        <ul>
          <li><strong>Add User</strong> &mdash; Create a new account with username, display name, password, and role.</li>
          <li><strong>Edit User</strong> &mdash; Change display name or role.</li>
          <li><strong>Reset Password</strong> &mdash; Set a new password for any user.</li>
          <li><strong>Disable MFA</strong> &mdash; Turn off multi-factor authentication for a user.</li>
          <li><strong>Delete User</strong> &mdash; Remove a user account. You cannot delete yourself or the last admin.</li>
        </ul>

        <h3>Password Requirements</h3>
        <p>
          All passwords must meet the following complexity requirements:
          minimum 8 characters, at least one uppercase letter, one lowercase
          letter, one number, and one special character.
        </p>

        <h3>Multi-Factor Authentication (MFA)</h3>
        <p>
          Users can enable TOTP-based MFA using an authenticator app (Google Authenticator, Authy, etc.).
          When enabled, a 6-digit code is required after entering the password during login.
          Admins can disable MFA for any user from this page.
        </p>
      </>
    ),
  },

  account: {
    title: "My Account",
    content: (
      <>
        <p>View your account information and manage security settings.</p>

        <h3>Change Password</h3>
        <p>
          Click <strong>Change Password</strong> to update your password. You
          must enter your current password for verification, then provide a new
          password that meets the complexity requirements.
        </p>

        <h3>Multi-Factor Authentication (MFA)</h3>
        <p>
          Add an extra layer of security to your account by enabling TOTP-based
          multi-factor authentication. When enabled, you will need to enter a
          6-digit code from your authenticator app each time you sign in.
        </p>

        <h4>Enabling MFA</h4>
        <ol>
          <li>Click <strong>Enable MFA</strong> on the account page.</li>
          <li>Scan the QR code with your authenticator app (Google Authenticator, Authy, Microsoft Authenticator, etc.).</li>
          <li>Enter the 6-digit code shown in your app to verify and activate MFA.</li>
        </ol>

        <h4>Disabling MFA</h4>
        <p>
          Click <strong>Disable MFA</strong> and enter your password to confirm.
          An admin can also disable MFA for any user from the User Management page.
        </p>
      </>
    ),
  },

  updates: {
    title: "Updates",
    content: (
      <>
        <p>
          Check for application updates, apply them, and configure automatic
          updates.
        </p>

        <h3>Current Version</h3>
        <p>
          Displays the currently installed version of Training Tracker. Click{" "}
          <strong>Check for Updates</strong> to query GitHub for the latest
          release.
        </p>
        <p>
          If your repository is <strong>private</strong>, you need to set a{" "}
          <code>GITHUB_TOKEN</code> environment variable so the app can
          authenticate with the GitHub API. To create one:
        </p>
        <ol>
          <li>
            Go to <strong>GitHub &gt; Settings &gt; Developer settings &gt;
            Personal access tokens &gt; Fine-grained tokens</strong>
          </li>
          <li>Generate a new token scoped to your Training Tracker repository</li>
          <li>
            Grant <strong>Contents: Read-only</strong> permission
          </li>
          <li>
            Add <code>GITHUB_TOKEN=&quot;your_token&quot;</code> to your{" "}
            <code>.env</code> file and restart the application
          </li>
        </ol>

        <h3>Available Update</h3>
        <p>
          When an update is available, the release version, name, date, and
          release notes are displayed. Click <strong>Update Now</strong> to
          start the update process. The system will pull the latest code,
          install dependencies, run database migrations, rebuild the
          application, and restart the service.
        </p>

        <h3>Update Progress</h3>
        <p>
          During an update, a progress bar shows the current step. Do not close
          the page while the update is in progress. On completion, a success
          message is shown with the new version number.
        </p>

        <h3>Rollback &amp; Error Handling</h3>
        <p>
          Before starting an update, the system creates a backup of the current
          build and database. If any step fails (dependency installation,
          database migration, build, or service restart), the system
          automatically rolls back to the previous working version. The
          rollback restores the git state, build output, and database.
        </p>

        <h3>Update Log</h3>
        <p>
          Click <strong>Update Log</strong> to view a detailed timestamped log
          of the most recent update. The log includes each step performed, any
          errors encountered, and rollback details if applicable.
        </p>

        <h3>Update Channels</h3>
        <p>
          The system supports two update channels controlled by the{" "}
          <code>UPDATE_CHANNEL</code> environment variable in your{" "}
          <code>.env</code> file:
        </p>
        <ul>
          <li>
            <strong>stable</strong> (default) — Only shows full production
            releases. Recommended for production systems.
          </li>
          <li>
            <strong>dev</strong> — Shows all releases including pre-releases.
            Use this for development/testing systems that track the{" "}
            <code>dev</code> branch.
          </li>
        </ul>
        <p>
          The current channel is displayed as a clickable badge next to the
          version number. Click it to switch channels. Switching checks out the
          target branch, pulls the latest code, rebuilds, and restarts. When
          switching from dev back to stable, the system verifies that the latest
          stable release is at or ahead of your installed version to prevent
          downgrades. Pre-releases are marked with an amber{" "}
          <strong>Pre-release</strong> badge in the releases list.
        </p>

        <h3>Recent Releases</h3>
        <p>
          Shows details of the last 5 releases from GitHub. Click any release
          to expand and view its release notes. Your currently installed version
          is highlighted with a <strong>Current</strong> badge. On the dev
          channel, pre-releases are shown with a <strong>Pre-release</strong>{" "}
          badge. A link at the bottom takes you to the full releases page on
          GitHub.
        </p>

        <h3>Automatic Updates</h3>
        <p>
          Enable automatic updates to have the system check for and apply
          updates on a schedule. Configure the frequency (daily or weekly) and
          time. If an automatic update fails, it will be rolled back
          automatically. The update channel setting determines whether
          pre-releases are included in automatic update checks.
        </p>
      </>
    ),
  },

  backup: {
    title: "Backup & Restore",
    content: (
      <>
        <p>Create or restore full system backups.</p>

        <h3>Create Backup</h3>
        <p>
          Click <strong>Download Backup</strong> to generate and download a{" "}
          <code>.zip</code> file containing all system data. The backup
          includes:
        </p>
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Contents</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>region_data.json</code></td>
              <td>All country/region mappings</td>
            </tr>
            <tr>
              <td><code>training_data.json</code></td>
              <td>All training program definitions</td>
            </tr>
            <tr>
              <td><code>students.json</code></td>
              <td>All student records</td>
            </tr>
            <tr>
              <td><code>training_taken.json</code></td>
              <td>All training completion records</td>
            </tr>
            <tr>
              <td><code>import_metadata.json</code></td>
              <td>Import timestamps</td>
            </tr>
            <tr>
              <td><code>backup_metadata.json</code></td>
              <td>Backup version and creation timestamp</td>
            </tr>
          </tbody>
        </table>

        <h3>Restore from Backup</h3>
        <p>
          Click <strong>Upload Backup File</strong> and select a previously
          created backup <code>.zip</code> file. A confirmation dialog will
          appear &mdash; type <code>RESTORE</code> to proceed.
        </p>
        <p><strong>What happens during restore:</strong></p>
        <ol>
          <li>
            All existing data is deleted (regions, training data, students,
            training records, import metadata).
          </li>
          <li>
            Data from the backup is inserted in the correct order to satisfy
            foreign key constraints.
          </li>
          <li>
            All operations run inside a single database transaction &mdash; if
            any step fails, no changes are made.
          </li>
        </ol>
        <p>
          <strong>Important:</strong> Restoring a backup{" "}
          <strong>replaces all existing data</strong>. Create a backup of the
          current system first if you need to preserve it.
        </p>

        <h3>Automatic Backups</h3>
        <p>
          Enable automatic backups to have the system save a backup to a local
          directory on a schedule. Configure the backup location, retention
          count, frequency (daily or weekly), and time.
        </p>
        <ul>
          <li>
            <strong>Location</strong> &mdash; The directory where backups are
            saved. Click <strong>Browse</strong> to open a folder picker. You
            can also create new folders from the browser.
          </li>
          <li>
            <strong>Keep last N backups</strong> &mdash; When the number of
            saved backups exceeds this count, the oldest are automatically
            deleted.
          </li>
          <li>
            <strong>Run Backup Now</strong> &mdash; Immediately saves a backup
            to the configured location without waiting for the schedule.
          </li>
        </ul>

        <h3>Saved Backups</h3>
        <p>
          Lists all backup zip files in the configured directory. You can
          restore directly from a saved backup by clicking{" "}
          <strong>Restore</strong> next to the file, or delete individual
          backups with <strong>Delete</strong>.
        </p>
      </>
    ),
  },
  "scheduled-exports": {
    title: "Scheduled Exports",
    content: (
      <>
        <p>
          Scheduled Exports let you automatically generate and deliver reports
          on a recurring basis — daily, weekly, or monthly — without any manual
          steps.
        </p>

        <h3>Adding a Schedule</h3>
        <p>Click <strong>Add Schedule</strong> and configure:</p>
        <table>
          <thead>
            <tr><th>Field</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Name</strong></td><td>A descriptive label for this schedule</td></tr>
            <tr><td><strong>Report</strong></td><td>Which report to export (e.g. Expiring Soon)</td></tr>
            <tr><td><strong>Format</strong></td><td>CSV, Excel (XLSX), or PDF</td></tr>
            <tr><td><strong>Destination</strong></td><td>Where to send the file</td></tr>
            <tr><td><strong>Schedule</strong></td><td>Frequency, day, and time</td></tr>
          </tbody>
        </table>

        <h3>Destinations</h3>
        <table>
          <thead>
            <tr><th>Destination</th><th>What you need</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Local Filesystem</strong></td><td>A writable path on the server</td></tr>
            <tr><td><strong>Email</strong></td><td>SMTP credentials + recipient address</td></tr>
            <tr><td><strong>Google Drive</strong></td><td>OAuth credentials (Client ID, Secret, Refresh Token)</td></tr>
            <tr><td><strong>Box</strong></td><td>App credentials (Client ID, Secret, Access Token)</td></tr>
            <tr><td><strong>OneDrive</strong></td><td>Azure app registration (Client ID, Tenant ID, Secret)</td></tr>
          </tbody>
        </table>

        <h3>Provider Credentials</h3>
        <p>
          Expand the <strong>Provider Credentials</strong> section to enter
          authentication details for cloud providers and email. Credentials are
          stored in the database and shared by all schedules using that
          provider. For email (SMTP), a <strong>Test Connection</strong> button
          appears after saving credentials — click it to verify the SMTP server
          is reachable and the credentials are valid without sending an email.
        </p>

        <h3>Actions</h3>
        <p>
          Each schedule row has four action buttons: <strong>Run Now</strong>{" "}
          (immediately trigger the export), <strong>Enable/Disable</strong>{" "}
          (pause without deleting), <strong>Edit</strong>, and{" "}
          <strong>Delete</strong>. The <em>Last Run</em> column shows when the
          export last executed and whether it succeeded or failed.
        </p>

        <h3>How Scheduling Works</h3>
        <p>
          A cron job runs every minute on the server. It checks which enabled
          schedules are due at the current time and executes them
          automatically. No action is required from you once a schedule is
          saved and enabled.
        </p>
      </>
    ),
  },
  "admin-program-data": {
    title: "Program Data",
    content: (
      <>
        <p>
          The Program Data page lets you define the requirements for partner
          compliance programs such as Authorized Professional Services (APS).
        </p>

        <h3>Fields</h3>
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Program Name</strong></td>
              <td>The name of the partner program (e.g., &quot;Authorized Professional Services (APS)&quot;).</td>
            </tr>
            <tr>
              <td><strong>Specialisation</strong></td>
              <td>The product specialisation (e.g., &quot;Cortex XDR&quot;, &quot;Prisma Access&quot;). Managed via a controlled list — click + to add new ones.</td>
            </tr>
            <tr>
              <td><strong>Level</strong></td>
              <td>Whether this requirement applies at Country, Theatre, or Global level.</td>
            </tr>
            <tr>
              <td><strong>Type</strong></td>
              <td>Certification, Accreditation, or Instructor-Led Training.</td>
            </tr>
            <tr>
              <td><strong>Training</strong></td>
              <td>The specific training required, filtered by the selected Type.</td>
            </tr>
            <tr>
              <td><strong>Quantity Required</strong></td>
              <td>For Country/Theatre: number of people needed. For Global with training: number of people globally. For Global without training: number of compliant theatres needed.</td>
            </tr>
            <tr>
              <td><strong>Minimum per Theatre</strong></td>
              <td>Optional. For Global-level requirements with training — the minimum number of certified people required per theatre (used by Global Diamond).</td>
            </tr>
          </tbody>
        </table>

        <h3>Adding Requirements</h3>
        <p>
          Use <strong>Add Requirement</strong> to create a single entry. For Global-level
          requirements, check <strong>No specific training</strong> if the entry counts
          compliant theatres (APS-style), or leave unchecked to specify a training title
          (Global Diamond-style).
        </p>

        <h3>Alternative Trainings (OR Logic)</h3>
        <p>
          Check <strong>Accept alternative trainings</strong> to specify other
          certifications, accreditations, or trainings that also satisfy a requirement.
          For example, if a requirement needs 5 people with &quot;XSIAM Engineer&quot;
          certification, you can add &quot;XSIAM Select&quot; as an alternative — students
          with either training (or a mix of both) count toward the 5.
        </p>
        <p>
          Each alternative has its own Type and Training selection. Students are
          deduplicated — a student with both the primary and an alternative training
          counts only once.
        </p>

        <h3>Bulk Import</h3>
        <p>
          Use the <strong>Import</strong> button to upload a CSV or Excel file containing
          multiple requirements at once. Click <strong>Download Template</strong> in the
          import dialog to get a CSV template with example rows.
        </p>
        <p>
          Expected columns: Program Name, Specialisation, Level, Training Type, Training,
          Quantity Required, Minimum per Theatre, Alternatives. Column names are matched
          case-insensitively. Specialisations are auto-created if they don&apos;t exist.
          Training is matched by display name against the training catalog. Alternatives
          are specified as pipe-separated training names (e.g., &quot;XSIAM Select|Another Training&quot;).
        </p>
        <p>
          Use <strong>Validate</strong> to check all rows for errors before committing,
          then <strong>Import</strong> to write the data.
        </p>

        <h3>Export</h3>
        <p>
          Use the <strong>Export</strong> button to download the current data as
          CSV, Excel, or PDF.
        </p>
      </>
    ),
  },
  "programs-aps": {
    title: "APS — Authorized Professional Services",
    content: (
      <>
        <p>
          The APS dashboard shows compliance status for the Authorized
          Professional Services partner program. It provides four report views.
        </p>

        <h3>Country Report</h3>
        <p>
          Select a country to see whether it meets each specialisation&apos;s
          requirements. Each column represents a specialisation, with rows
          showing the training name, required count, and attained count.
          Green means the requirement is met; red means it is not. Click
          <strong> View</strong> to see the list of qualifying students.
        </p>

        <h3>Region Report</h3>
        <p>
          Same as the Country Report but aggregated across all countries in a
          region. Select a region to see combined compliance data for every
          country that belongs to it.
        </p>

        <h3>Theatre Report</h3>
        <p>
          Same as the Country Report but aggregated at the theatre level.
          Select a theatre to view compliance.
        </p>

        <h3>Global Report</h3>
        <p>
          Shows how many theatres are fully compliant for each specialisation.
          A theatre is considered compliant if it meets <em>all</em> theatre-level
          requirements for that specialisation. The &quot;Required&quot; number
          is the target number of compliant theatres.
        </p>

        <h3>Alternative Trainings</h3>
        <p>
          If a requirement has alternative trainings configured (OR logic), they
          appear below the primary training name in blue text. The attained count
          reflects students with <em>any</em> of the accepted trainings
          (primary or alternatives), deduplicated by student.
        </p>

        <h3>Exports</h3>
        <p>
          Each report section has an Export button to download the compliance
          data as CSV, Excel, or PDF.
        </p>
      </>
    ),
  },
  "programs-global-diamond": {
    title: "Global Diamond",
    content: (
      <>
        <p>
          The Global Diamond dashboard shows compliance status for the Global
          Diamond partner program. All requirements are evaluated at the global
          level — there are no country or theatre selectors.
        </p>

        <h3>Specialisations</h3>
        <p>
          Each specialisation appears as a card with a <strong>Compliant</strong>{" "}
          or <strong>Not Compliant</strong> badge. A specialisation is compliant
          only when <em>all</em> of its requirements are met.
        </p>

        <h3>Requirements Table</h3>
        <p>
          Each row shows a specific training requirement with:
        </p>
        <ul>
          <li><strong>Training</strong> — the training title and type</li>
          <li><strong>Required (Global)</strong> — total number of certified people needed globally</li>
          <li><strong>Attained</strong> — distinct active certifications held globally</li>
          <li><strong>Min/Theatre</strong> — minimum required per theatre (if applicable)</li>
          <li><strong>Status</strong> — Met or Not Met</li>
        </ul>

        <h3>Theatre Breakdown</h3>
        <p>
          When a requirement has a per-theatre minimum, a chevron icon appears
          on the left of the row. Click it to expand a breakdown showing each
          theatre&apos;s count and whether it meets the minimum.
        </p>
        <p>
          A requirement is only <strong>Met</strong> if the global total is
          reached <em>and</em> all theatres meet their per-theatre minimum.
        </p>

        <h3>Alternative Trainings</h3>
        <p>
          If a requirement has alternative trainings (OR logic), they appear
          below the primary training name in blue text. Attained counts and
          theatre breakdowns reflect students with <em>any</em> accepted
          training (primary or alternatives), deduplicated by student.
        </p>

        <h3>Export</h3>
        <p>
          Use the Export button to download all compliance data (including
          theatre breakdowns) as CSV, Excel, or PDF.
        </p>

        <h3>Configuration</h3>
        <p>
          Requirements are managed in{" "}
          <strong>Admin &rsaquo; Program Data</strong>. Add entries with the
          program name <strong>Global Diamond</strong>, set the level to{" "}
          <strong>Global</strong>, select the training, set the global quantity
          required, and optionally set a &quot;Minimum per Theatre&quot; value.
        </p>
      </>
    ),
  },
};

export function getHelpContent(slug: string): HelpSection | null {
  return helpSections[slug] ?? null;
}
