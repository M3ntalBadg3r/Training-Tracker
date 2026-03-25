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
          Reports are presented as collapsible sections, each with their own
          filters and export options.
        </p>

        <h3>By Product Type</h3>
        <p>
          Detailed listing of all training records, filterable by product type,
          training type, and theatre. This is the report behind the{" "}
          <strong>By Product Type</strong> dashboard chart.
        </p>

        <h3>By Function</h3>
        <p>
          Detailed listing of all training records, filterable by function,
          training type, and theatre. This is the report behind the{" "}
          <strong>By Function</strong> dashboard chart.
        </p>

        <h3>Expiring Soon</h3>
        <p>
          Shows training records expiring within a selectable time window (1, 3,
          or 6 months). Filterable by training type and theatre. This is the
          report behind the <strong>Expiring Soon</strong> dashboard chart.
        </p>

        <h3>Achieved Over Last 12 Months</h3>
        <p>
          Shows all training records completed in the last 12 months, filterable
          by training type and theatre. This is the report behind the{" "}
          <strong>Achieved Over Last 12 Months</strong> dashboard chart.
        </p>

        <h3>Trained but not Certified</h3>
        <p>
          This report identifies students who have completed an{" "}
          <strong>Instructor-Led Training</strong> but have <strong>not</strong>{" "}
          obtained the associated <strong>Certification</strong>.
        </p>
        <p>
          The association is determined by the certification mapping configured
          in <strong>Admin &gt; Training Data</strong>.
        </p>

        <h4>Columns displayed</h4>
        <ul>
          <li>Full Name</li>
          <li>Email Address</li>
          <li>Theatre</li>
          <li>Region</li>
          <li>Country</li>
          <li>Instructor-Led Training (shown as Full Title)</li>
          <li>Certification Not Obtained (shown as Full Title)</li>
        </ul>

        <h4>Filtering</h4>
        <ul>
          <li>Search by name or email</li>
          <li>Filter by Theatre, Region, Country, Training, or Certification</li>
        </ul>

        <h4>Export</h4>
        <p>Export filtered results as CSV, Excel, or PDF.</p>
      </>
    ),
  },

  admin: {
    title: "Admin",
    content: (
      <>
        <p>
          The Admin page provides links to sub-pages and a Danger Zone for data
          management.
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
        </ul>

        <h3>Wipe Data</h3>
        <p>
          In the <strong>Danger Zone</strong> section, you can permanently delete
          all data in the system (students, training records, training data, and
          region data). This action requires typing <code>WIPE</code> in a
          confirmation dialog to proceed.{" "}
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
      </>
    ),
  },
};

export function getHelpContent(slug: string): HelpSection | null {
  return helpSections[slug] ?? null;
}
