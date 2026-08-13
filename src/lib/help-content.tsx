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
        <p>
          Five summary cards are displayed at the top. The four &quot;earned&quot;
          cards (Certifications, Accreditations, Instructor-Led Trainings, OLX
          Completed) show the total number of completions of that type as the
          headline figure, with a smaller <strong>&quot;Held by N students&quot;</strong>
          sub-metric underneath — the number of distinct students who have at
          least one completion of that type. The two lines together give a
          quick read of both depth (records) and breadth (reach).
        </p>
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
              <td>Total certification completions across all students, with a sub-metric of distinct students holding any certification</td>
            </tr>
            <tr>
              <td><strong>Accreditations Earned</strong></td>
              <td>Total accreditation completions across all students, with a sub-metric of distinct students holding any accreditation</td>
            </tr>
            <tr>
              <td><strong>Instructor-Led Trainings</strong></td>
              <td>Total ILT completions across all students, with a sub-metric of distinct students who have attended any ILT</td>
            </tr>
            <tr>
              <td><strong>OLX Completed</strong></td>
              <td>
                Total OLX completions across all students, with a sub-metric of
                distinct students who have completed any OLX. An OLX is
                &quot;completed&quot; when the student has completed every
                sub-item linked to that OLX, or when the OLX has no sub-items
                and the student has a completion for it directly.
              </td>
            </tr>
          </tbody>
        </table>

        <h3>Update Notifications</h3>
        <p>
          When a newer release of Training Tracker is available, <strong>SuperAdmins</strong>
          see a blue banner at the top of the Dashboard with a link to the
          <strong> Updates</strong> page. The banner can be dismissed for the current
          browser session; it returns next session, or sooner if an even newer release
          appears. Admins and Users never see it.
        </p>

        <h3>Night Mode</h3>
        <p>
          Click the <strong>Moon</strong> icon in the sidebar to switch to night
          (dark) mode. Click the <strong>Sun</strong> icon to switch back. Your
          preference is saved and persists across sessions.
        </p>

        <h3>Mobile &amp; Small Screens</h3>
        <p>
          On phones and other narrow screens the sidebar is hidden and replaced by a
          <strong> &#9776; menu button</strong> in the top bar &mdash; tap it to slide
          the navigation in over a dimmed backdrop, and tap a link, the &times;, or the
          backdrop to close it. On tablets and desktops the sidebar stays docked. Wide
          tables scroll sideways so nothing is cut off, and pop-up dialogs fit the
          screen and scroll internally when tall.
        </p>

        <h3>Geographic Filter</h3>
        <p>
          Use the cascading <strong>Theatre</strong> &rarr; <strong>Region</strong>{" "}
          &rarr; <strong>Country</strong> dropdowns in the top-right corner to filter
          all metrics and charts by geography. Leave all three on{" "}
          <em>All&nbsp;&hellip;</em> for a global view, or narrow down: picking a
          theatre limits the region choices, and picking a region limits the country
          choices (changing a higher level resets the ones below it). Previously
          selected scopes are cached for instant switching.
        </p>

        <h3>Active / Inactive Filter</h3>
        <p>
          By default the Dashboard counts only <strong>active</strong>{" "}
          (non-expired) training, so the metric cards and charts reflect
          currently-valid certifications, accreditations, ILTs and OLX. Tick{" "}
          <strong>Include expired (inactive)</strong> next to the geographic
          filter to also count expired completions. The choice is cached
          alongside the geographic scope for instant switching.
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
                type (the admin-managed product type list)
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
              <td><strong>Achievement Over Time</strong></td>
              <td>Line chart</td>
              <td>Trend of completions over a selectable time range (1/3/6/12 months or custom), with prior-period comparison</td>
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
          detailed record. Your search, column filters, and sort order are kept
          in the page URL, so opening a student and pressing <strong>Back</strong>
          restores the list exactly as you left it.
        </p>
        <p>
          The header shows a <strong>Last imported</strong> date/time for the
          company currently selected in the header switcher (or the most recent
          import system-wide when <strong>All companies</strong> is selected). If
          the selected company has never had a student import, the line is blank.
        </p>
        <p>
          Admins can click <strong>Add Student</strong> to create a student
          manually without an import. Provide Full Name, Email, Company, and
          pick a Country from the dropdown &mdash; the Theatre and Region are
          auto-derived from the country&apos;s entry in Region Data and shown
          read-only. The dropdown only lists countries that have a theatre
          assigned. To add a new country, ask a SuperAdmin to create it on the
          <strong> Region Data</strong> page first.
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
            Theatre, Country, Region, and the student&apos;s <strong>Company</strong>
            (shown in the sub-line under their name). Click <strong>Edit</strong>
            to modify Full Name, Email, Country, or Company. Theatre and Region
            are auto-derived from the chosen country (read-only); the Company
            dropdown lists the companies you have access to. If the student&apos;s current
            country has no theatre set in Region Data, it appears in the
            dropdown with a short &quot;&#9888; no theatre&quot; marker (and the
            Theatre box explains it) &mdash; pick a properly-configured country,
            or ask a SuperAdmin to set the theatre in Region Data. A country
            that already has a theatre is never flagged. Changes are previewed
            in a confirmation modal before saving.
          </li>
          <li>
            <strong>Summary Badges</strong> &mdash; Counts of active
            Certifications, Accreditations, Instructor-Led Trainings, and OLX
            completed, plus an <strong>Expiring in 6 Months</strong> badge
            counting the student&apos;s active Certifications and Accreditations
            whose expiry falls within the next six months. When any of the
            student&apos;s active achievements are legacy (retired/superseded),
            the relevant card (Certifications, Accreditations, Instructor-Led
            Trainings, or OLX) also shows an orange &quot;N legacy&quot; pill so
            you can see at a glance how many should be renewed or replaced. Note
            that only Certifications and Accreditations can currently be flagged
            legacy.
          </li>
          <li>
            <strong>Achievement Over Time</strong> &mdash; A chart of the
            student&apos;s completed training per month across their full
            history, so you can see when they earned their qualifications.
          </li>
          <li>
            <strong>Training Records</strong> &mdash; A table of all trainings
            completed by the student, including Title (with link if available),
            Type, Product, Function, Completed Date, Expiry Date, and Active
            status.
          </li>
        </ul>
        <p>
          Admins can manage training records and the student themselves while
          in edit mode:
        </p>
        <ul>
          <li>
            <strong>Add Training</strong> &mdash; Pick a training from the
            catalog and a completed date. If the chosen training maps to
            multiple internal training titles, a second selector appears to
            disambiguate. Expiry is automatically set to two years after the
            completed date.
          </li>
          <li>
            <strong>Edit</strong> on any row &mdash; Adjust the completed date.
            Expiry is recalculated automatically.
          </li>
          <li>
            <strong>Remove</strong> on any row &mdash; Queues the row for
            deletion when you click Save.
          </li>
          <li>
            <strong>Delete Student</strong> &mdash; Permanently removes the
            student and every one of their training records. A confirmation
            popup is shown first; this action cannot be undone.
          </li>
        </ul>
        <p>
          Add, Edit, and Remove changes are queued and applied together when
          you click <strong>Save</strong>.
        </p>
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
          by student location. Tick <strong>Active only</strong> to restrict
          the Students Taken count to students whose training has not expired.
          When filters are active, the Students Taken count reflects only
          students matching the selected filters, and trainings with no
          matching students are hidden.
        </p>
        <p>
          All filters — including the table&apos;s own search box, column
          filters, and sort order — are saved in the page URL, so navigating
          into a training and pressing <strong>Back</strong> restores the
          full view. Use the <strong>Export</strong> button to download the
          currently visible rows (after every filter, search, and sort is
          applied) as CSV, Excel, or PDF. The menu offers two variants:{" "}
          <strong>Catalogue</strong> (one row per training, like the table)
          and <strong>Catalogue with students</strong> (one row per training
          × student — every holder of every visible training).
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
            where possible, recognising common header variants (e.g.{" "}
            <code>Email</code>/<code>Email Address</code>/<code>Student Email</code>,{" "}
            <code>Theatre</code>/<code>Theater</code>/<code>Acct Theatre</code>,{" "}
            <code>Country</code>/<code>Billing Country</code>,{" "}
            <code>Completion date</code>/<code>Date Completed</code>, and{" "}
            <code>ILT Name</code>/<code>Cert</code> for the{" "}
            <strong>Cert/Training</strong> field). The alias list is editable by
            SuperAdmins at <strong>System Settings &rarr; Import Aliases</strong>,{" "}
            so new CSV/Excel header variants can be added without a code change
            &mdash; the tab also has CSV/Excel/PDF export and CSV/Excel import
            (two columns: <code>Target Field</code>, <code>Alias</code>) for
            bulk maintenance. Manually adjust any unmatched columns. Required fields are: a name,
            Email Address, Theatre, Country, Cert/Training, and Completed Date.
            For the name, map{" "}
            <strong>either</strong> a single <strong>Full Name</strong> column{" "}
            <strong>or</strong> both <strong>First Name</strong> and{" "}
            <strong>Last Name</strong> &mdash; split names are merged into one
            record (and an explicit Full Name value wins on any row that has
            both). The name dropdowns and preview columns adapt to your file:
            whichever name style it uses is shown, and the other is hidden.
          </li>
          <li>
            <strong>Processing</strong> &mdash; The system imports the data,
            creating students and training records as needed.
          </li>
          <li>
            <strong>Summary</strong> &mdash; A summary shows counts of students
            created/updated, trainings imported/skipped, and an{" "}
            <strong>Issues</strong> list. Issues includes both hard errors
            (rows skipped) and warnings (rows imported with adjustments) such
            as a row&apos;s theatre being overridden by the value in Region
            Data.
          </li>
        </ol>

        <h3>Date Format Detection</h3>
        <p>
          Dates in the Completed Date column are parsed against the{" "}
          <strong>system default date format</strong> (set in Admin &gt; System Settings).
          Before any rows are committed, the import inspects the column:
        </p>
        <ul>
          <li>
            <strong>Match</strong> &mdash; every cell fits the system default. The import runs silently.
          </li>
          <li>
            <strong>Ambiguous</strong> &mdash; every cell happens to fit both{" "}
            <code>DD/MM/YYYY</code> and <code>MM/DD/YYYY</code> (e.g. all day numbers
            are 1&ndash;12). The import runs using the system default and adds a single
            line to the summary so you know the file couldn&apos;t be disambiguated.
          </li>
          <li>
            <strong>Mismatch</strong> &mdash; at least one cell forces the other
            format (e.g. month=15 in a system set to <code>DD/MM/YYYY</code>). A modal
            appears: <em>&quot;This file looks like MM/DD/YYYY. Use it for this import?&quot;</em>{" "}
            Accept to override for that import only; cancel and either fix the file
            or change the system default.
          </li>
          <li>
            <strong>Internal conflict</strong> &mdash; different cells force different
            formats (some <code>13/01/2025</code>, others <code>01/15/2025</code>).
            The import is rejected; clean the file and retry.
          </li>
        </ul>
        <p>
          Rows that fail to parse against the chosen format are reported
          per-row with the expected format shown in the error message, rather
          than silently producing a wrong-date row.
        </p>
        <p>
          <strong>Native Excel dates</strong> &mdash; in <code>.xlsx</code>/
          <code>.xls</code> files, cells that Excel stores as real dates (not
          text) are read by their true value and converted automatically, no
          matter how they&apos;re displayed (e.g. <code>m/d/yy</code> or a raw
          serial like <code>46147</code>). They&apos;re unambiguous, so the
          format prompt above only applies to genuine text dates and CSV cells.
        </p>
        <p>
          <strong>Day/month-swapped Excel dates</strong> &mdash; re-saving an
          <code>MM/DD</code> file in a <code>DD/MM</code>-locale Excel can
          silently transpose the day and month of its native date cells (a true
          <code>2026-01-12</code> becomes a stored <code>2026-12-01</code>,
          landing in the future). When a native date cell in the Completed Date
          column decodes to a future date that swapping would fix, the import
          pauses and shows a confirmation modal with sample corrections. Choose
          <strong>Yes, correct them</strong> to repair the transposed dates, or
          <strong>Import as-is</strong> if the dates are genuinely correct. Each
          cell is only swapped when the corrected value isn&apos;t in the future,
          so genuinely-correct recent dates (and any day above 12) are left
          untouched &mdash; mixed files are handled. Text date cells are
          unaffected.
        </p>

        <h3>Theatre handling</h3>
        <p>
          Region Data is the source of truth for a country&apos;s theatre. For
          each row that has a country:
        </p>
        <ul>
          <li>
            <strong>Country in Region Data with a theatre</strong> &mdash; the
            student&apos;s theatre is set from Region Data. If the imported
            theatre disagrees, the row imports with a warning showing what was
            overridden.
          </li>
          <li>
            <strong>Country in Region Data without a theatre</strong> &mdash;
            the imported theatre is kept and a warning asks a SuperAdmin to
            populate the theatre in Region Data.
          </li>
          <li>
            <strong>Country not in Region Data</strong> &mdash; the country is
            auto-created with region &quot;Unknown&quot; (and the imported
            theatre, if any). A warning asks a SuperAdmin to verify and fill in
            the missing values.
          </li>
        </ul>

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
          The Reports section contains nine report pages, each accessible from
          the sidebar or the Reports landing page. Dashboard chart cards link
          directly to the relevant report. Every report exports as CSV, Excel,
          or PDF (tabular data only — charts are screen-only).
        </p>

        <h3>Common Features</h3>
        <ul>
          <li><strong>KPI strip</strong> — four headline metrics at the top of every report.</li>
          <li><strong>Charts above the table</strong> — bars/areas/leaderboards summarising the filtered data.</li>
          <li><strong>Drill-down</strong> — click a chart segment to filter the table in place; a small &quot;Clear filter&quot; link appears when active.</li>
          <li><strong>Theatre / Region / Country filters</strong> &mdash; a cascading scope selector narrows the whole report to a chosen geography. Choosing a theatre limits the region list to that theatre, and choosing a region limits the country list; changing a higher level resets the ones below it. Leave them on &quot;All&quot; to see everything.</li>
          <li><strong>Group by</strong> &mdash; toggle theatre / region / country grouping. The hierarchy rolls up: country → region → theatre, with a fallback to theatre when region is missing or &quot;unknown&quot;.</li>
          <li><strong>Sortable columns</strong> — click any column header to sort the table; click again to reverse the direction (an ▲/▼ arrow marks the active column). Tables default to Full Name A–Z (or the report&rsquo;s natural primary column). When grouping is on, rows sort within each group.</li>
          <li><strong>Date-range picker</strong> — limit results to a date window (where applicable). Includes presets for Last 30/90 days, Last 12 months, YTD, and All time.</li>
          <li><strong>Paginated tables</strong> — the detail-heavy reports (By Product Type, By Function, Expiring Soon, Achievement Over Time, Trained But Not Certified, Legacy Replacement Gap, Currently Expired, Learner Achievement Scorecard) are computed on the server and page through their rows one page at a time — use the <strong>Show N records</strong> selector and the numbered page buttons beneath the table. Charts, KPI cards and exports always cover the full filtered set, not just the visible page.</li>
          <li><strong>Back restores your view</strong> — your filters, search, grouping, sort, page number and page size are kept in the page address, so clicking into a record and pressing your browser&rsquo;s Back button returns you to the report exactly as you left it. This also applies to the Students and Training lists. The address can also be bookmarked or shared to reopen the same filtered view.</li>
          <li><strong>Dark mode</strong> — chart axes, gridlines, and tooltips adapt automatically.</li>
        </ul>

        <h3>By Product Type</h3>
        <p>Stacked bar of Cert/Accred/ILT per product, plus an active-vs-expired donut. Tick <strong>Count people, not records (active holders)</strong> to switch the chart and KPI cards from raw record counts to the number of distinct people who currently hold an active cert/training — so a learner holding several certs in one product type counts once per type instead of inflating the totals.</p>

        <h3>By Function</h3>
        <p>Stacked bar of Cert/Accred/ILT per function (Sales, Pre-Sales, Deployments), plus an active-vs-expired donut. Tick <strong>Count people, not records (active holders)</strong> to switch the chart and KPI cards from raw record counts to the number of distinct active holders, so multiple certs held by the same person don&rsquo;t skew the figures.</p>

        <h3>Expiring Soon</h3>
        <p>Horizon bar showing records expiring within 1/3/6/12 months, plus a theatre × month stacked bar showing where the cliff falls.</p>

        <h3>Currently Expired</h3>
        <p>Every certification &amp; training whose latest completion has <em>already</em> lapsed (the inverse of Expiring Soon). Records are bucketed by how long ago they expired (≤1 month, 1–3, 3–6, 6–12, &gt; 12 months) with a stacked bar by training type and an &ldquo;Expired by Theatre&rdquo; chart. The <strong>Lapsed</strong> dropdown narrows the report to a recent window — <strong>Lapsed Any Time</strong> (the default) or lapsed within the last <strong>3 / 6 / 12 months</strong> — scoping the charts, KPI cards, subtotals, table and exports together; its edges line up with the chart bands, so at 3 months the &ldquo;1–3 months&rdquo; band is the last populated one and the bands sum to the total. Choosing a window that excludes a band you had clicked clears that band filter instead of showing an empty report. Click a band to filter the table; group by theatre/region/country, search, and export to CSV/Excel/PDF. Retired (legacy) certs are shown by default — tick <strong>Exclude retired (legacy) certs</strong> to hide them. The detail table is <strong>paginated</strong> — use the page controls beneath it to page through results; charts, KPI cards and exports always cover the full filtered set. Also available as a scheduled export.</p>

        <h3>Achievement Over Time</h3>
        <p>Area chart of completions with a dashed prior-period comparison line, plus a top-10 leaderboard of trainings by completion count. Pick a preset time range (12, 6, 3, or 1 month) or a custom date range; the chart automatically buckets by day, week, or month based on the window. Click a point to filter the table to that bucket. Type/theatre/function/region/product filters update the chart as well as the table.</p>

        <h3>Trained But Not Certified</h3>
        <p>Gap funnel by product (ILT completed → ILT still active) plus the top theatres/regions/countries with gaps. When a training can lead to more than one certification, the options are treated as alternatives (OR): a student is only flagged if they hold none of them, and the &ldquo;Certification Not Obtained&rdquo; column lists every option joined with &ldquo;or&rdquo;.</p>

        <h3>Legacy Replacement Gap</h3>
        <p>Learners who hold a <strong>legacy</strong> Certification/Accreditation but haven&rsquo;t taken its <strong>replacement</strong> (configured in Admin &gt; Training Data). Multiple replacements are alternatives — holding any one clears the learner. The expiry-horizon chart and the Already Expired / ≤ 1 / 3 / 6 / 12-month window filter key on the learner&rsquo;s legacy training expiry, so you can chase the most urgent migrations first. Two toggles tailor the view: <strong>Include legacy with no replacement</strong> (show holders of a retired cert with no successor) and <strong>Replacement must be active</strong> (when off, a previously-held but now-expired replacement also counts as satisfied).</p>

        <h3>Theatre / Region / Country Comparison</h3>
        <p>
          Compare geographies side by side. A single toggle switches the whole
          report between Theatre, Region, and Country. The matrix table shows,
          per geography: headcount (student population), counts of
          Certifications / Accreditations / ILTs / OLX, total trainings,
          trainings per student, and the number of active trainings expiring in
          the next 3 and 6 months. Every column is sortable and a totals row
          summarises all geographies. The chart panel above the table compares
          geographies by training type, function, or product (grouped bars), or
          plots completions over time (one line per geography). The time-range
          preset (3 / 6 / 12 months, all time, or a custom date range) and the Function / Product /
          Type filters narrow both the table and the chart. Counts respect the
          selected time range; the expiring columns always look forward from
          today.
        </p>

        <h3>Training Catalogue Health</h3>
        <p>
          Per-training metrics (total completions, last-12-month completions,
          active students, expiring within 90 days, uptake %). Highlights
          zero-uptake titles and mass-expiry-risk titles.
        </p>

        <h3>Program Compliance Trend</h3>
        <p>
          Monthly snapshots over the last 12 months for each configured program.
          A line chart per specialisation shows how compliance % moves over
          time. Filter by program. The same union-of-primary-and-alternatives
          logic used by the live dashboards is applied at each historical
          snapshot.
        </p>

        <h3>Renewal Forecast</h3>
        <p>
          Projects upcoming renewals vs lapses for the next 6 and 12 months.
          Renewal rate is derived from history per training (≥5 expiries),
          falling back to per product, then global. A renewal counts when a
          follow-up record lands within ±90 days of the previous expiry.
        </p>
      </>
    ),
  },

  "reports-learner-scorecard": {
    title: "Learner Achievement Scorecard",
    content: (
      <>
        <p>
          A learner-centric view — one row per person summarising what each
          learner has achieved, what&apos;s due for renewal, and where the gaps
          are. Useful both for recognising top achievers and for spotting
          under-trained learners.
        </p>
        <ul>
          <li><strong>Certs / Accreds / ILTs / OLX</strong> — counts per learner. Active completions only by default; tick <strong>Include expired in counts</strong> to count expired ones too.</li>
          <li><strong>Total</strong> — sum of the four count columns; also drives the Top Achievers leaderboard.</li>
          <li><strong>Expiring Soon</strong> — active Certifications/Accreditations whose expiry falls within the selected window (1/3/6 months); always looks forward from today.</li>
          <li><strong>Expired</strong> — the learner&apos;s expired achievements.</li>
          <li><strong>Gaps</strong> — trainings the learner completed without earning the mapped certification (same logic as Trained But Not Certified).</li>
          <li><strong>Last Achievement</strong> — most recent completion date across all of the learner&apos;s records.</li>
          <li>The whole roster is included, so learners with no completions appear with all-zero counts. OLX sub-items are excluded (the parent OLX counts once it&apos;s complete).</li>
          <li>Filter by theatre/region/country and search by name or email; every column is sortable and the table exports to CSV/Excel/PDF.</li>
          <li>The detail table is <strong>paginated</strong> — use the controls beneath it to page through learners and change the page size; the KPI cards, leaderboard and exports always cover the full filtered set.</li>
        </ul>
      </>
    ),
  },

  "reports-catalogue-health": {
    title: "Training Catalogue Health",
    content: (
      <>
        <p>
          Per-training catalogue metrics that help you spot dead and at-risk
          training titles.
        </p>
        <ul>
          <li><strong>Zero Completions</strong> — titles in the catalogue that have never been completed by anyone.</li>
          <li><strong>Stale</strong> — titles with completions historically but none in the last 12 months.</li>
          <li><strong>Mass-Expiry Risk</strong> — titles with the highest count of active records expiring in the next 90 days.</li>
          <li><strong>Uptake %</strong> — distinct active students / total students globally.</li>
        </ul>
      </>
    ),
  },

  "reports-program-compliance-trend": {
    title: "Program Compliance Trend",
    content: (
      <>
        <p>
          Tracks monthly compliance over the last 12 months — plus a 12-month
          forecast — for the partner programs configured in{" "}
          <strong>Admin &gt; Program Data</strong>.
        </p>
        <ul>
          <li>For each month-end, the report re-runs the same OR-logic union of primary + alternative trainings used by the live program dashboards, counting only trainings that were <strong>completed by that month and still valid</strong> (not yet expired). This makes each point a true snapshot of that moment — historical lines reflect how compliance actually built up over time.</li>
          <li><strong>Solid lines</strong> are history; <strong>dashed lines</strong> (after the &quot;Forecast →&quot; marker) project the next 12 months. The forecast assumes <strong>no new completions</strong> and simply shows compliance decaying as today&apos;s active certifications reach their expiry date — an &quot;if nothing changes&quot; view that surfaces upcoming renewal gaps.</li>
          <li>The <strong>Forecast 12-mo Δ</strong> KPI shows the projected change (in percentage points) from now to 12 months out — a negative value flags certifications due to lapse.</li>
          <li>Narrow the view with the <strong>Theatre / Region / Country</strong> filters (the &quot;Showing&quot; caption states the active scope); the report is also scoped to the company selected in the header. The program dropdown lists every program found in Program Data.</li>
        </ul>
      </>
    ),
  },

  "reports-renewal-forecast": {
    title: "Renewal Forecast",
    content: (
      <>
        <p>
          Forecasts how many of the trainings expiring in the next 12 months
          will be renewed vs lapsed, based on historical renewal behaviour.
        </p>
        <ul>
          <li>A <strong>renewal</strong> is any later re-completion of the same training by the same student (at least 30 days after the previous one, so duplicate rows aren&apos;t double-counted). An expired record with no later re-completion is a <strong>lapse</strong>.</li>
          <li><strong>Renewal rate</strong> is computed per training when ≥5 historical expiries exist; otherwise it falls back to per-product, then to a global rate.</li>
          <li>The at-risk leaderboard ranks trainings by projected lapses over the 12-month horizon.</li>
          <li>Use the <strong>Theatre / Region / Country</strong> filters to scope the whole report — the metric boxes, the monthly chart, and the at-risk table all update together. The filters cascade (picking a theatre narrows the regions, and so on).</li>
        </ul>
      </>
    ),
  },

  offerings: {
    title: "Offerings",
    content: (
      <>
        <p>
          <strong>Offerings</strong> track a partner&apos;s ability to deliver a
          joint product offering. Each offering bundles one or more{" "}
          <strong>specialisations</strong>, and each specialisation lists the
          supporting trainings (Certifications, Accreditations, ILTs, OLXs) — with
          alternatives and a minimum required count — needed to deliver it.
        </p>
        <p>
          Offerings are <strong>company-scoped</strong>: each offering belongs to
          one company, so only users (and API keys) with access to that company
          can see or manage it. Offering names are unique <strong>per company</strong>,
          so two companies can each have an offering with the same name.
        </p>
        <ul>
          <li>Pick a <strong>Country</strong> or <strong>Region</strong> to see capability. Nothing is shown until you make a selection.</li>
          <li><strong>Onshore</strong> counts the distinct people who hold each training in the selected country (or the region&apos;s countries). A <strong>Met / Not met</strong> badge compares the Onshore count against the minimum required.</li>
          <li><strong>Nearshore</strong> counts the rest of that country/region&apos;s <strong>theatre</strong>, with the onshore countries removed — the wider in-theatre capability available to support delivery.</li>
          <li><strong>Offshore</strong> counts everyone <strong>worldwide</strong> who holds the training, with the onshore countries removed (so it includes the nearshore people plus every other theatre). Nearshore and Offshore are informational and don&apos;t change the Met status.</li>
          <li>Figures are scoped to the offering&apos;s company. Use <strong>Export</strong> for the current view, and click <strong>View</strong> on any count to list the people behind it.</li>
        </ul>
        <p className="text-sm text-gray-500">
          Offerings are configured under <strong>Admin &gt; Offerings</strong> by a
          company&apos;s Admins or a SuperAdmin (create, edit, import/export — each
          scoped to a company). That page&apos;s header shows a{" "}
          <strong>Last imported</strong> date/time for the selected company (or the
          most recent import system-wide under <strong>All companies</strong>);
          blank when the selected company has never had an offerings import. They
          are included in both full and config backups.
        </p>
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
              <td>Leading, trailing, or repeated internal whitespace</td>
              <td>Trimmed and collapsed</td>
            </tr>
            <tr>
              <td><strong>Email as Name</strong></td>
              <td>Full name is an email address</td>
              <td>Derived from email local part (e.g. jane.doe@co.com &rarr; Jane Doe)</td>
            </tr>
            <tr>
              <td><strong>Question Marks</strong></td>
              <td>Full name contains only question marks and whitespace (e.g. <code>?</code>, <code>? ??</code>, <code>??? ??</code>)</td>
              <td>Derived from email local part (e.g. jane.doe@co.com &rarr; Jane Doe)</td>
            </tr>
            <tr>
              <td><strong>Duplicate Name</strong></td>
              <td>Full name repeats the same word (e.g. <code>Jane Jane</code>)</td>
              <td>Duplicates removed. A fuller name is taken from the email only when it names the same person &mdash; otherwise the single remaining word is kept (<code>Jane Jane</code> &rarr; <code>Jane</code>)</td>
            </tr>
            <tr>
              <td><strong>Numbers</strong></td>
              <td>Digits in the name</td>
              <td>Removed</td>
            </tr>
            <tr>
              <td><strong>Special Characters</strong></td>
              <td>Characters other than letters, spaces, hyphens and apostrophes (periods are flagged too, and become word separators)</td>
              <td>Removed. Accented and non-Latin letters are left alone, and a typographic apostrophe is converted rather than deleted (<code>O&rsquo;Brien</code> &rarr; <code>O&apos;Brien</code>)</td>
            </tr>
          </tbody>
        </table>
        <p>
          Every suggested fix is itself clean &mdash; applying one can never leave
          a name that the next scan flags again. Names derived from an email
          address have digits and plus-addressing tags stripped
          (<code>jane11.jane@co.com</code> &rarr; <code>Jane</code>, not{" "}
          <code>Jane11 Jane</code>), and initials are never mistaken for
          duplicates (<code>J R R Smith</code> is left alone). Casing is corrected
          only when a name is entirely upper- or lower-case, so{" "}
          <code>McDonald</code> and <code>van der Berg</code> survive a scan
          intact.
        </p>
        <p>
          Results are shown in a table with the issues highlighted inline. The
          <strong> Suggested Fix</strong> for each row is shown in an editable
          field, so you can override the suggested name before applying it. Where
          no safe automatic fix exists the field is left blank with a prompt to
          enter one, and the row cannot be selected until you do. By default no
          rows are selected after a scan &mdash; tick the rows you want to fix
          (or use the issue filter chips to bulk-select), then click{" "}
          <strong>Fix Selected</strong>.
        </p>

        <h3>Future Completion Dates</h3>
        <p>
          Click <strong>Scan for Issues</strong> to list every training record
          whose <strong>Completed Date</strong> is later than today. These rows
          are usually data-entry mistakes &mdash; a course cannot be completed
          in the future. They also inflate dashboard counts and push expiry
          dates out by two years from the wrong starting point.
        </p>
        <p>
          Each row&apos;s completed date is shown as an editable date input
          (highlighted in amber while it is still in the future). Pick the
          correct date and click <strong>Save</strong> on that row to commit
          the change. There is no automated fix &mdash; every correction is
          made manually, one row at a time. Saving recomputes the expiry as
          completed + 2 years.
        </p>

        <h3>Wipe All Data</h3>
        <p>
          The <strong>Danger Zone</strong> at the bottom of this page offers two
          destructive actions. <strong>Both cannot be undone.</strong>
        </p>
        <ul>
          <li>
            <strong>Wipe All Data (Keep Accounts)</strong> — Permanently deletes
            all students, training records, training data, product types, region
            data, programs, companies, and scheduled exports, but keeps your user
            accounts so you stay signed in. Type <code>WIPE</code> to confirm.
          </li>
          <li>
            <strong>Factory Reset (Wipe Everything)</strong> — Deletes
            everything, including all user accounts, and returns the system to
            its brand-new state — you are taken to the first-run setup wizard to
            create a new admin. Type <code>RESET</code> to confirm.
          </li>
        </ul>
      </>
    ),
  },

  "region-data": {
    title: "Region Data",
    content: (
      <>
        <p>
          Manage the mapping between countries, regions, and theatres. This is
          the source of truth for a country&apos;s theatre &mdash; it drives the
          country dropdown on the student add/edit forms and validates theatres
          during student imports.
        </p>

        <h3>Features</h3>
        <ul>
          <li>
            <strong>View</strong> &mdash; Table of all countries with their
            assigned region and theatre. Countries with no theatre are flagged
            so you can fix them.
          </li>
          <li>
            <strong>Search / Filter</strong> &mdash; Filter by country name,
            region, or theatre. The Theatre column has a special
            &quot;(missing)&quot; filter to find rows that still need a theatre.
          </li>
          <li>
            <strong>Add</strong> &mdash; Add a new country with its region and
            (optionally) theatre. A country without a theatre cannot be selected
            for new students &mdash; set the theatre before assigning students.
          </li>
          <li>
            <strong>Edit</strong> &mdash; Click <strong>Edit</strong> on any row
            to modify the country, region, or theatre inline, then{" "}
            <strong>Save</strong> or <strong>Cancel</strong>.
          </li>
          <li>
            <strong>Delete</strong> &mdash; Remove a country/region mapping.
          </li>
          <li>
            <strong>Import</strong> &mdash; Upload a CSV or Excel file with{" "}
            <code>Country</code>, <code>Region</code>, and (optionally){" "}
            <code>Theatre</code> columns. The system auto-maps columns and shows
            a preview before importing. Existing rows are updated when the
            imported value differs.
          </li>
          <li>
            <strong>Export</strong> &mdash; Download all region data (including
            theatre) as CSV, Excel, or PDF.
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
              <td>
                Certification, Accreditation, Instructor-Led Training, OLX, or
                OLX Sub-Item. An <strong>OLX</strong> can be a single training
                or a parent that bundles multiple <strong>OLX Sub-Items</strong>
                {" "}&mdash; the parent is only counted as completed once a
                student has finished every sub-item.
              </td>
            </tr>
            <tr>
              <td><strong>Product</strong></td>
              <td>One of the configured product types (managed in Admin &rsaquo; Product Types)</td>
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
              <td>
                The Certification(s) an ILT or OLX parent <strong>leads to</strong>{" "}
                &mdash; the recommended preparation before sitting the exam that
                earns the cert (the training does not itself grant it). Shown
                without opening each row: a <strong>&ldquo;&rarr; Leads
                to: &hellip;&rdquo;</strong> subline under the Full Title in the
                list, and a <strong>Leads to Certification(s)</strong> card on the
                Full Title detail page.
              </td>
            </tr>
            <tr>
              <td><strong>Parent Training Title</strong></td>
              <td>
                Optional. On import, populating this column marks the row as
                an OLX Sub-Item that belongs to the named parent OLX. Use a
                comma-separated list to assign the sub-item to multiple
                parents.
              </td>
            </tr>
          </tbody>
        </table>

        <p>
          The list shows <strong>one row per Full Title</strong> &mdash; the
          first-class &ldquo;record&rdquo;. Because several Training Titles can
          map to the same Full Title, the page groups them so you can manage the
          training as a single thing. A Full Title that contains an{" "}
          <strong>OLX</strong> parent shows an expand arrow and a sub-item count;
          expand it to reveal the parent&rsquo;s <strong>OLX Sub-Items</strong>{" "}
          nested underneath (they are not listed as separate top-level rows).
        </p>

        <h3>Features</h3>
        <ul>
          <li>
            <strong>Add Training</strong> &mdash; Click{" "}
            <strong>Add Training</strong> to open a modal form for creating a
            new training entry.
          </li>
          <li>
            <strong>Edit (open the Full Title)</strong> &mdash; Click{" "}
            <strong>Edit</strong> on any row (or click the row) to open the{" "}
            <strong>Full Title detail page</strong>, which lists every Training
            Title mapped to that Full Title and offers group-wide bulk actions.
          </li>
          <li>
            <strong>Search / Filter</strong> &mdash; Search by training title or
            full title; filter by Type, Product, or Function. A{" "}
            <strong>Show legacy only</strong> toggle scopes the list to retired
            Certs/Accreds. Your search, filters, legacy toggle, and sort are
            remembered when you open a training and click <strong>Back</strong>{" "}
            (they&rsquo;re kept in the page URL, so the view is bookmarkable too).
          </li>
          <li>
            <strong>Import</strong> &mdash; Upload a CSV or Excel file. Columns
            can be mapped to all fields including Certification and{" "}
            <strong>Parent Training Title</strong> (which marks a row as an OLX
            sub-item belonging to one or more parent OLX trainings &mdash;
            comma-separated when shared between parents). The system supports
            common aliases for type values (e.g. <code>ILT</code>,{" "}
            <code>cert</code>, <code>pre-sales</code>, <code>olx</code>).
          </li>
          <li>
            <strong>Export</strong> &mdash; Download all training data as CSV,
            Excel, or PDF (one row per Training Title, so it round-trips with
            import).
          </li>
        </ul>

        <h3>Full Title Detail Page</h3>
        <p>
          Opening a Full Title takes you to a dedicated page (like a student
          record) showing all of its mapped Training Titles. From here you can:
        </p>
        <ul>
          <li>
            <strong>Rename Full Title</strong> &mdash; Renames every mapped
            Training Title&rsquo;s Full Title at once.
          </li>
          <li>
            <strong>Mark the whole Full Title as Legacy</strong> &mdash;
            Cascades the legacy flag to <strong>all</strong>{" "}
            Certification/Accreditation Training Titles under it in one click
            (other types are unaffected). Pick the replacement as a{" "}
            <strong>Full Title</strong> and it is expanded to the underlying
            replacements automatically.
          </li>
          <li>
            <strong>Set Product / Function for all</strong> &mdash; Apply a
            product type or function across every mapped Training Title.
          </li>
          <li>
            <strong>Per-Title editing</strong> &mdash; Each Training Title keeps
            its own Link, Certifications, and OLX membership, and can still be
            edited or deleted individually.
          </li>
          <li>
            <strong>Add / Delete</strong> &mdash; Add another Training Title to
            this Full Title, or delete the whole group at once.
          </li>
        </ul>

        <h3>Newly-discovered trainings (import)</h3>
        <p>
          When a student import references a training title that doesn&rsquo;t
          exist yet, it is auto-created and highlighted in an amber{" "}
          <strong>&ldquo;needs attention&rdquo;</strong> section at the top of
          the page. When completing one, you can either{" "}
          <strong>attach it to an existing Full Title</strong> via a dropdown
          (it inherits that group&rsquo;s Type/Product/Function as editable
          defaults) or <strong>create a new Full Title</strong>, then click{" "}
          <strong>Mark as Complete</strong>.
        </p>

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

        <h3>Legacy Certifications &amp; Replacements</h3>
        <p>
          A <strong>Certification</strong> or <strong>Accreditation</strong> can
          be flagged as <strong>Legacy</strong> when it has been retired or
          superseded by a newer one.
        </p>
        <ul>
          <li>
            On the <strong>Full Title detail page</strong>, tick{" "}
            <strong>Mark this Full Title as Legacy</strong> to retire every
            Certification/Accreditation under it at once. (The Add Training modal
            and per-Title editor also expose the same <strong>Mark as Legacy</strong>{" "}
            control.)
          </li>
          <li>
            A <strong>Replaced by</strong> picker of all other{" "}
            <strong>Full Titles</strong> that contain a
            Certification/Accreditation then appears &mdash; select one or more.
            Multiple replacements are <strong>alternatives</strong>: holding any
            one of them counts as having migrated. Leave it empty for a cert
            retired with no successor.
          </li>
          <li>
            A <strong>Legacy</strong> badge appears in the catalogue, on the
            training detail page, and next to the training on each learner&apos;s
            record (with the replacement name). On this admin page the grouped
            row&apos;s badge is followed by an inline{" "}
            <em>&rarr; Replaced by: &lt;names&gt;</em> subtitle (or{" "}
            <em>&rarr; No replacement defined</em>), so you can audit
            replacements at a glance. Tick <strong>Show legacy only</strong> in
            the search bar to scope the list to retired Certs/Accreds.
          </li>
          <li>
            Changing the type away from Certification/Accreditation clears the
            legacy flag and replacements.
          </li>
          <li>
            During import, set a <strong>Legacy</strong> column to{" "}
            <code>Yes</code> and list replacement training titles
            (comma-separated) in a <strong>Replacement</strong> column.
          </li>
          <li>
            The <strong>Legacy Replacement Gap</strong> report uses this to find
            learners still holding a legacy cert who haven&apos;t taken the
            replacement.
          </li>
        </ul>
      </>
    ),
  },

  "companies": {
    title: "Companies",
    content: (
      <>
        <p>
          Companies group students into separate tenants. Every student is
          assigned to exactly one company, and Admin/User accounts can only see
          data for the companies they have been granted access to.
        </p>
        <h3>Managing companies</h3>
        <ul>
          <li><strong>Add Company</strong> &mdash; SuperAdmin only. Pick a unique name; the company becomes selectable in the global header switcher and in user/import/export forms.</li>
          <li><strong>Rename</strong> &mdash; Updates the company everywhere (students keep their assignments).</li>
          <li><strong>Delete</strong> &mdash; Only allowed when no students or scheduled exports reference the company. Reassign or remove dependents first.</li>
        </ul>
        <p>
          The default <strong>Unassigned</strong> company is created automatically
          on upgrade and holds students that existed before company support was
          added. Reassign students from there in <strong>Students &rarr; (row) &rarr; Edit</strong>.
        </p>
      </>
    ),
  },
  "user-management": {
    title: "User Management",
    content: (
      <>
        <p>
          Manage user accounts for the Training Tracker system. Only SuperAdmins
          can access this page.
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
              <td><strong>SuperAdmin</strong></td>
              <td>Full system access — companies, users, training/region catalogs, backups, cleanup, updates. Sees every company.</td>
            </tr>
            <tr>
              <td><strong>Admin</strong></td>
              <td>Scoped to one or more assigned companies. Can edit students, run imports, and manage scheduled exports for those companies.</td>
            </tr>
            <tr>
              <td><strong>User</strong></td>
              <td>Read-only access to Dashboard, Students, Training, Reports, and Programs — limited to assigned companies. No edit/delete.</td>
            </tr>
          </tbody>
        </table>

        <h3>Features</h3>
        <ul>
          <li><strong>Add User</strong> &mdash; Create a new account with username, display name, password, role, and (for non-SuperAdmin roles) the companies they can see. The <strong>Require MFA at first login</strong> checkbox is on by default; the new user will be locked to the MFA enrolment page until they set up an authenticator.</li>
          <li><strong>Edit User</strong> &mdash; Change display name, role, or company assignments. Tick <strong>Require MFA at next login</strong> to force an existing user to enrol in MFA on their next session.</li>
          <li><strong>Reset Password</strong> &mdash; Set a new password for any user.</li>
          <li><strong>Disable MFA</strong> &mdash; Turn off multi-factor authentication for a user.</li>
          <li><strong>Delete User</strong> &mdash; Remove a user account. You cannot delete yourself or the last admin.</li>
        </ul>

        <h3>Columns</h3>
        <ul>
          <li><strong>Username</strong> &mdash; Stored in lowercase. Login is case-insensitive (typing <code>Alice</code>, <code>alice</code>, or <code>ALICE</code> all match the same account).</li>
          <li><strong>MFA</strong> &mdash; <em>Enabled</em> (green) when the user has set up an authenticator, <em>Required</em> (amber) when an admin has flagged the user with <strong>mustEnableMfa</strong> but they haven&apos;t enrolled yet, otherwise <em>Disabled</em>.</li>
          <li><strong>Last login</strong> &mdash; Date and time of the most recent successful login (24-hour format).</li>
          <li><strong>Last IP</strong> &mdash; Source IP of the most recent login, taken from the <code>X-Forwarded-For</code> header.</li>
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
          Admins can disable MFA for any user from this page, or force enrolment with the
          <strong>Require MFA</strong> checkboxes in the Add and Edit User modals.
        </p>

        <h3>Brute-force protection</h3>
        <p>
          Login is defended on two levels. A <strong>per-IP limit</strong> caps
          attempts (10 per 15 minutes) so a single machine can&rsquo;t hammer the
          login form. On top of that, a <strong>per-account lockout</strong> kicks
          in after 5 consecutive failed attempts (wrong password or wrong MFA code)
          for the same account: the account is temporarily locked, and the lock
          window grows with each further failure (1 &rarr; 2 &rarr; 5 &rarr; 15
          &rarr; 30 minutes). A successful login clears it. This is what stops a
          spread-out attack that guesses one account&rsquo;s password from many
          different IP addresses. If a user reports being locked out after mistyped
          passwords, it clears itself once the window elapses. The limits are stored
          in the database, so they are not reset by a server restart.
        </p>
        <p>
          The <strong>Failed login attempts</strong> panel below the user table shows
          recent rejected logins (the username tried &mdash; including made-up ones
          from spray attacks &mdash; the source IP, the reason, and the time). A
          currently <strong>locked</strong> account shows a red <em>Locked</em> badge
          with an <strong>Unlock</strong> button, and any currently throttled IP can be
          cleared with <strong>Unblock IP</strong>. Unlocking lets that user (or IP) in
          again straight away; the log is kept for 30 days.
        </p>
      </>
    ),
  },

  account: {
    title: "My Account",
    content: (
      <>
        <p>View your account information and manage security and display settings.</p>

        <h3>Display Date Format</h3>
        <p>
          Choose how dates are shown to you across the app &mdash; pick{" "}
          <code>DD/MM/YYYY</code>, <code>MM/DD/YYYY</code>, or leave it set to
          <strong> Use system default</strong> to follow whatever the SuperAdmin has
          configured for the instance. Your choice only affects your view; the data
          itself is stored format-neutrally and other users keep their own preference.
        </p>

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

  "system-settings": {
    title: "System Settings",
    content: (
      <>
        <p>
          SuperAdmin-only page for instance-wide defaults. Settings here apply to
          every user unless they override the value on their own <strong>My Account</strong> page.
        </p>

        <h3>Default Date Format</h3>
        <p>
          Choose between <code>DD/MM/YYYY</code> (UK / EU) and <code>MM/DD/YYYY</code> (US).
          The setting controls two things:
        </p>
        <ul>
          <li>
            <strong>Imports</strong> &mdash; CSV / Excel uploads parse Completed Date cells
            against this format. If the file&apos;s dates clearly use the other format (e.g.
            month=15 in a system set to <code>DD/MM/YYYY</code>), the import pauses and
            asks before continuing &mdash; see <strong>Import &gt; Date Format Detection</strong>.
          </li>
          <li>
            <strong>Display</strong> &mdash; dates throughout the app render in this format
            for any user who hasn&apos;t set their own preference.
          </li>
        </ul>
        <p>
          Changing the setting is non-destructive: stored data is format-neutral, so
          switching back and forth only changes how dates are parsed and shown going
          forward.
        </p>

        <h3>Session Timeout</h3>
        <p>
          On the <strong>Session</strong> tab, set how long a signed-in user can be
          <strong> inactive</strong> before they are automatically signed out (default
          <strong> 30 minutes</strong>, adjustable between 5 minutes and 24 hours).
        </p>
        <ul>
          <li>
            A warning dialog with a live countdown appears about a minute before the
            timeout, so an active user can click <strong>Stay signed in</strong> to
            continue.
          </li>
          <li>
            Ongoing activity keeps the session alive automatically &mdash; the timer
            only counts genuine inactivity.
          </li>
          <li>
            A fixed <strong>absolute cap</strong> (8 hours by default) still applies:
            every session ends once it reaches the cap, even for a continuously-active
            user, requiring a fresh sign-in.
          </li>
        </ul>
        <p>
          Changes take effect the next time a user signs in.
        </p>

        <h3>Branding</h3>
        <p>
          The <strong>Branding</strong> tab white-labels the app for your
          organisation. Everything here applies instance-wide and takes effect
          immediately &mdash; there is no reinstall, rebuild or restart.
        </p>
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Where it shows</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Application name</strong></td>
              <td>
                The sidebar heading, the browser tab title, the login and setup
                pages, the About page, and the entry your users see in their
                authenticator app when they set up MFA. Up to 60 characters.
              </td>
            </tr>
            <tr>
              <td><strong>Brand colour</strong></td>
              <td>
                Re-tints every accent in the app &mdash; buttons, links, focus
                rings, active tabs and the selected navigation item &mdash; in both
                light and dark mode. Clear the field to return to the default blue.
              </td>
            </tr>
            <tr>
              <td><strong>Logo</strong></td>
              <td>
                The login, first-run setup and MFA-enrolment pages. PNG, JPEG,
                WebP or ICO, up to 512&nbsp;KB. Without one, a built-in shield icon
                is used.
              </td>
            </tr>
            <tr>
              <td><strong>Favicon</strong></td>
              <td>
                The browser tab icon. PNG or ICO, up to 128&nbsp;KB; square and at
                least 32&times;32 works best.
              </td>
            </tr>
            <tr>
              <td><strong>Login page switches</strong></td>
              <td>
                Hide the logo and/or the name on the login page independently &mdash;
                useful when your logo already contains the name, or when you want a
                plain sign-in form. The sidebar always shows the name.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Notes.</strong> Charts and PDF exports keep their own colour
          palette and are not re-tinted. If you pick a light brand colour the app
          warns you, because buttons use white text on that colour. SVG uploads
          are refused for security reasons &mdash; an SVG can carry scripts.
          Branding is included in configuration backups, and a full{" "}
          <strong>Wipe</strong> from Data Clean-Up resets it to the defaults.
        </p>
        <p>
          Use <strong>Reset to defaults</strong> to clear the name, colour, logo
          and favicon in one step. It doesn&apos;t touch any of your data.
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
          During an update, a progress bar shows the current step. The progress
          panel pins to the top of the page while the update is running, so it
          stays visible as you scroll. The page also warns you if you try to
          refresh the tab or click a sidebar link before the update completes —
          the update itself continues in the background, but leaving the page
          hides the progress indicator. On completion, a success message is
          shown with the new version number.
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
        <p>
          When an <code>ENCRYPTION_KEY</code> is configured, a standard backup is
          encrypted with <strong>this server&apos;s</strong> key (saved as{" "}
          <code>.zip.enc</code>) and can only be restored on the same system.
        </p>

        <h3>Portable Backup</h3>
        <p>
          To restore on a <strong>different</strong> installation, click{" "}
          <strong>Portable backup&hellip;</strong> and choose a passphrase (at
          least 8 characters). The archive is encrypted from the passphrase
          rather than the server key, so it can be restored anywhere by
          re-entering the same passphrase. <strong>Keep the passphrase safe —
          the data cannot be recovered without it.</strong>
        </p>

        <h3>Config Backup</h3>
        <p>
          A <strong>config backup</strong> contains the reference dataset only
          — product types, regions, the training catalogue, OLX relationships,
          specialisations, programs, import aliases, and system settings — and
          excludes students and training records. Use this to clone the
          catalogue/program setup into a freshly installed instance without
          carrying any learner data across.
        </p>
        <p>
          Click <strong>Config Backup</strong> for the standard variant (tied
          to <code>ENCRYPTION_KEY</code>) or <strong>Portable config
          backup&hellip;</strong> for the passphrase-encrypted variant that
          restores anywhere. The archive is saved as{" "}
          <code>training-tracker-config-&lt;timestamp&gt;.zip[.enc]</code>.
        </p>
        <p>
          Restoring a config backup wipes and replaces the included reference
          tables but leaves <code>Student</code> and <code>TrainingTaken</code>
          {" "}rows untouched, so it&apos;s safe to run on a populated system
          when you just need to refresh the catalogue. The archive type is
          auto-detected on upload.
        </p>

        <h3>Restore from Backup</h3>
        <p>
          Click <strong>Upload Backup File</strong> and select a previously
          created backup file. For a <strong>portable</strong> backup, enter its
          passphrase in the <strong>Portable backup passphrase</strong> field
          (leave it blank for a standard backup). A confirmation dialog will
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
    title: "Scheduled Report Exports",
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
            <tr><td><strong>Google Drive</strong></td><td>An OAuth Client ID + Secret. Connect via the wizard — Training Tracker captures the refresh token automatically.</td></tr>
            <tr><td><strong>Box</strong></td><td>A Custom App Client ID + Secret (User Authentication OAuth 2.0). Connect via the wizard — Training Tracker captures the refresh token automatically.</td></tr>
            <tr><td><strong>OneDrive</strong></td><td>An Entra (Azure AD) Web app Client ID + Secret. Connect via the wizard — Training Tracker captures a delegated refresh token; uploads land in your own OneDrive.</td></tr>
          </tbody>
        </table>

        <h3>Connecting cloud providers (wizard)</h3>
        <p style={{ color: "#dc2626", fontWeight: "bold" }}>
          Cloud providers such as Google, Box, &amp; OneDrive require a business
          account and will not work with consumer accounts. You will also be
          required to expose the instance to the internet so that the OAuth
          process can complete.
        </p>
        <p>
          Each cloud destination has a <strong>Connect with …</strong> button
          that opens a guided OAuth wizard. The wizard:
        </p>
        <ol>
          <li>Shows the exact <strong>redirect URI</strong> to register in the provider&rsquo;s developer console (with a Copy button).</li>
          <li>Walks you through registering an OAuth app and grabbing the Client ID and Secret.</li>
          <li>Opens a popup to the provider&rsquo;s consent screen — sign in and approve.</li>
          <li>Captures the refresh token automatically and runs a Test Connection so you can see who you&rsquo;re connected as.</li>
        </ol>
        <p>
          If your install is behind a reverse proxy, make sure
          <code>X-Forwarded-Proto</code> and <code>X-Forwarded-Host</code> are
          forwarded — the wizard derives the redirect URI from those headers.
        </p>

        <h3>Provider credentials section</h3>
        <p>
          The <strong>Provider Credentials</strong> section lists every
          provider with a status badge: <em>Healthy</em>,
          <em>Expires in N days</em>, <em>Expired</em>, <em>Auth failed</em>,
          or <em>Not configured</em>. Cloud cards offer{" "}
          <strong>Connect/Reconnect</strong>, <strong>Test Connection</strong>,
          and <strong>Remove</strong>. Email keeps the inline SMTP form with
          its own <strong>Test Connection</strong> button.
        </p>

        <h3>Credential health monitoring</h3>
        <p>
          Cloud refresh tokens have a finite lifetime — Box tokens expire
          after 60 days unused, OneDrive after about 90. A red/amber banner
          appears at the top of the Dashboard and this page if any credential
          has expired or is approaching expiry, with a one-click{" "}
          <strong>Reconnect</strong> link.
        </p>
        <p>
          A daily cron script (<code>deploy/auto-credential-check.sh</code>)
          probes each credential and updates its health status, so the banner
          stays accurate even when no schedule runs that day. The installer sets
          this up for you in <code>/etc/cron.d/training-tracker</code>; it runs
          as the unprivileged service account.
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
          compliance programs. Each program automatically gets its own dashboard
          under <strong>Programs</strong>.
        </p>
        <p>
          The main page shows one <strong>box per program</strong>. Click a box to
          open that program&apos;s page, where you can add, edit, and delete its
          requirements. Use <strong>New Program</strong> to create a program (it
          persists straight away, even before you add any requirements), the pencil
          icon on a box to <strong>rename</strong> a program (which also renames all
          of its requirements), and the bin icon to <strong>delete</strong> a program
          along with every one of its requirements. Import and Export cover all
          programs at once.
        </p>
        <p>
          <strong>Import replaces, it does not merge.</strong> For every program named in
          the file, its existing requirements are deleted and re-created from the file, so
          re-importing an edited export never duplicates rows (programs not in the file are
          left untouched). The preview warns you which programs will be replaced and asks
          you to tick a confirmation before importing. Export and import round-trip the full
          program structure — the program-level <strong>Deployment Handling</strong> and,
          for tiered programs, each tier&apos;s <strong>Tier Order</strong> and
          <strong> Tier Specialisations Required</strong> — so a program exported and
          re-imported unchanged is restored exactly (tiers with no requirements of their own
          travel as blank tier-definition rows). After a successful import the page header
          shows a <strong>Last imported</strong> date/time.
        </p>

        <h3>Tiered programs</h3>
        <p>
          Tick <strong>Tiered program</strong> when creating a program to unlock
          <strong> tiers</strong> (e.g. Tier A, B, C) that a partner reaches based on how
          many <strong>specialisations</strong> they have achieved. A specialisation is
          achieved when all of its qualifying (Sales/Pre-Sales) cert requirements are met
          by enough distinct people. On a tiered program&apos;s page a <strong>Tiers</strong>
          section lets you add tiers (name, ladder order, and how many specialisations each
          requires) and choose how <strong>Deployment</strong> cert requirements are handled:
        </p>
        <ul>
          <li><strong>Flat</strong> — each tier lists its own deployment cert requirements.</li>
          <li><strong>Per achieved specialisation</strong> — each achieved specialisation&apos;s
            own deployment cert requirements must be met (add these as requirements with
            purpose <em>Deployment</em>). The same set applies to every tier.</li>
          <li><strong>Per tier, per achieved specialisation</strong> — each tier lists its own
            deployment cert requirements <em>for each specialisation</em>, so they scale up the
            ladder. When adding a tier&apos;s deployment requirement you pick which specialisation
            it applies to. The tier is reached when <em>at least the required number of</em>
            specialisations each meet all of that tier&apos;s criteria — achieved <em>and</em> all
            of that tier&apos;s deployment certs for that specialisation (a specialisation with no
            deployment certs for the tier counts on qualification alone). Specialisations that
            aren&apos;t fully met don&apos;t count toward the total, so they don&apos;t block the
            tier once enough others are met. For example, Tier A might need 1 specialisation and no
            deployment certs, Tier B 2 specialisations each with 3 deployment certs, and Tier C 3
            specialisations each with 4 — so a partner with two specialisations fully deployed
            reaches Tier B even if a third specialisation&apos;s certs aren&apos;t complete.</li>
        </ul>
        <p>
          Because compliance counts <strong>distinct people</strong>, a requirement for
          &ldquo;2 of Cert A or Cert B&rdquo; needs two <em>different</em> individuals — one
          person holding both certs still counts once.
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
              <td>The name of the partner program. Each unique name gets its own compliance dashboard.</td>
            </tr>
            <tr>
              <td><strong>Specialisation</strong></td>
              <td>The product or solution area for this requirement. Managed via a controlled list — click + to add new ones.</td>
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
              <td>The specific training required, filtered by the selected Type. Each training name is listed once, even if it&apos;s backed by more than one catalogue record — the requirement counts anyone holding <em>any</em> record under that name.</td>
            </tr>
            <tr>
              <td><strong>Quantity Required</strong></td>
              <td>For Country/Theatre: number of people needed. For Global with training: number of people globally. For Global without training: number of compliant theatres needed.</td>
            </tr>
            <tr>
              <td><strong>Minimum per Theatre</strong></td>
              <td>Optional. For Global-level requirements with training — the minimum number of certified people required per theatre. When set, the dashboard shows a per-theatre breakdown.</td>
            </tr>
          </tbody>
        </table>

        <h3>Adding Requirements</h3>
        <p>
          Open a program&apos;s box, then use <strong>Add Requirement</strong> to create a
          single entry — the requirement is automatically attached to the program whose
          page you&apos;re on. For Global-level requirements, check <strong>No specific
          training</strong> if the entry counts compliant theatres, or leave unchecked to
          specify a training title with a global quantity (and optional per-theatre
          minimum). Specialisations are shared across programs and can be added inline via
          the <strong>+</strong> next to the Specialisation dropdown in the requirement form.
        </p>
        <p>
          A program&apos;s requirements table can be narrowed with the
          <strong> Specialisation</strong>, <strong>Level</strong>, and <strong>Type</strong>
          filters in the column headers; use <strong>Clear Filters</strong> to reset them.
        </p>

        <h3>Alternative Trainings (OR Logic)</h3>
        <p>
          Check <strong>Accept alternative trainings</strong> to specify other
          certifications, accreditations, or trainings that also satisfy a requirement.
          For example, if a requirement needs 5 people with a particular
          certification, you can add another equivalent certification as an
          alternative — students with either training (or a mix of both) count
          toward the 5.
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
          are specified as pipe-separated training names (e.g., &quot;Training A|Training B&quot;).
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
  "compliance-planning": {
    title: "Compliance Planning",
    content: (
      <>
        <p>
          Compliance Planning is the <strong>action layer</strong> over the
          program dashboards. The dashboards tell you <em>where the gaps are</em>;
          this page tells you <em>who to move, in what order, for the least
          effort</em> — floating the easy wins to the top.
        </p>
        <p>
          Program requirements are <strong>counts, not per-person mandates</strong>
          (&ldquo;3 people in the UK hold Cert A&rdquo;), so a plan computes the
          shortfall per requirement and then nominates the cheapest specific people
          to close it. It uses exactly the same distinct-holder counting — and the
          same <strong>scope rules</strong> — as the dashboards, so the two never
          disagree.
        </p>
        <p>
          The headline metric is <strong>People to certify</strong>: how many
          people still need to earn a certification to close the plan&apos;s gaps.
          It&apos;s <em>deduplicated</em> — if one person&apos;s single exam
          satisfies several requirements at once, they count once.
        </p>

        <h3>Choosing a target</h3>
        <p>
          Pick a <strong>Scope</strong> (Global / Theatre / Region / Country) and
          one or more <strong>programs</strong>. For each program you choose what to
          aim at:
        </p>
        <ul>
          <li>
            <strong>Tiered programs</strong> — target a <strong>tier</strong> (the
            tool picks the cheapest specialisations to get you there — reaching a
            tier only needs as many specialisations as the tier requires, and any
            <em>equally-cheap</em> alternatives are flagged &ldquo;Recommended&rdquo;
            so you can choose), or specific specialisation(s).
          </li>
          <li>
            <strong>Flat programs</strong> — pick specialisation(s) or{" "}
            <strong>all requirements</strong>.
          </li>
        </ul>
        <p>
          Mixed selections are supported (e.g. a tier in one program plus all
          specialisations in another) in a single plan.
        </p>

        <h3>Candidate ranking</h3>
        <p>For each gap, candidates are ranked cheapest-first:</p>
        <ul>
          <li>
            <strong>Renewal (expiring)</strong> — holds the required cert today,
            but it expires inside the renewal window. Only offered when{" "}
            <strong>Plan for this window</strong> is ticked (see below).
          </li>
          <li>
            <strong>Easy win</strong> — completed an ILT/OLX that leads to the
            required cert but never earned it; needs only the exam.
          </li>
          <li>
            <strong>Lapsed</strong> — held the cert but it expired; needs only a
            renewal.
          </li>
          <li>
            <strong>Legacy upgrade</strong> — holds a legacy cert whose replacement
            is the required cert.
          </li>
          <li>
            <strong>Net-new</strong> — needs the full ILT/OLX &rarr; cert path.
            Reported as a remaining count rather than named people.
          </li>
        </ul>
        <p>
          Because a person can only be <strong>spent once</strong>, the plan
          allocates candidates across the whole target. The{" "}
          <strong>&ldquo;Who to certify&rdquo;</strong> table lists one row per person
          with every gap they close (expand a row for detail) — so someone whose
          single exam closes the same cert in several places appears once. Two
          at-a-glance columns show <strong>which specialisation(s)</strong> that
          person would help fulfil and the <strong>relevant training they already
          hold</strong> (the ILT/OLX behind an easy win, or the legacy cert behind a
          legacy upgrade) — so it&apos;s obvious why they&apos;re a cheap candidate.
          Expanding a row spells each gap out in <strong>plain language</strong> —
          e.g. &ldquo;They have taken <em>Training A</em>. Passing the <em>Cert
          A</em> certification exam will contribute to the <em>Specialisation Y</em>
          specialisation.&rdquo; — worded to match their situation (training already
          taken, a lapsed renewal, or a legacy upgrade).
        </p>
        <p>
          Below &ldquo;Who to certify&rdquo;, an <strong>&ldquo;All eligible
          candidates&rdquo;</strong> section lists the <strong>full pool</strong> —
          everyone who already holds qualifying training and could be certified, not
          just the cheapest subset the plan nominates. Use it to pick alternatives
          (e.g. someone in a particular country) when the recommended person
          isn&apos;t the one you want to move.
        </p>

        <h3>Scope &amp; renewals</h3>
        <p>
          Each scope plans against <strong>only its own-level requirements</strong>,
          exactly like the program dashboards: choosing a <em>country</em> shows
          that country&apos;s Country-level requirements — not the theatre-wide
          requirement above it. Select the <em>theatre</em> if you want to plan
          against theatre-level requirements.
        </p>
        <p>
          The <strong>Renewal window</strong> (Off / 1 / 3 / 6 / 12 months) projects
          compliance forward, so you can see what upcoming expiry does to it. With a
          window selected, attained figures read <strong>current &rarr; projected</strong>{" "}
          (e.g. <em>16 &rarr; 3</em>) with a <strong>&#9660;N expiring</strong> note, and
          anything that is met <em>today</em> but falls below its requirement by the end
          of the window is shaded <strong>amber</strong> and badged{" "}
          <strong>&ldquo;At risk in Nmo&rdquo;</strong> alongside its green{" "}
          <strong>Achieved</strong> badge — it is compliant now and won&apos;t be then.
          The <strong>Renewals at risk</strong> section lists the holders whose training
          expires, led by a summary of exactly which requirements their expiry breaks.
        </p>
        <p>
          By default the window is <em>informational</em>: the KPIs and
          &ldquo;Who to certify&rdquo; still answer &ldquo;what is broken today?&rdquo;.
          Tick <strong>Plan for this window</strong> to fold it in — gaps are then sized
          from the projected figure, <strong>People to certify</strong> includes the
          renewals needed to hold compliance through the window, and those people appear
          in &ldquo;Who to certify&rdquo; as <strong>Renewal (expiring)</strong>{" "}
          candidates. For a tiered program this can change which specialisations are
          &ldquo;Recommended&rdquo;, since one that lapses inside the window no longer
          counts toward the tier.
        </p>

        <h3>Export</h3>
        <p>
          Use <strong>Export report</strong> in the page header to download the{" "}
          <em>whole plan</em> as one file — a summary of the KPI totals, the
          aggregate roadmap (every requirement gap), the &ldquo;Who to
          certify&rdquo; candidate list, and the renewals-at-risk list — in CSV,
          Excel, or PDF. In Excel each section becomes its own sheet; the PDF
          stacks each section as a headed table; CSV concatenates them with
          section titles. With a renewal window selected the roadmap gains projected
          columns and a <strong>Requirements at risk</strong> section is included, and
          the filename carries the window (and <em>-planned</em> when you are planning
          for it). The candidate list and the renewals list also keep their own
          per-section export buttons for a quick single-table download.
        </p>
      </>
    ),
  },
  "programs-detail": {
    title: "Program Compliance Dashboard",
    content: (
      <>
        <p>
          Each program dashboard shows compliance status for a partner program.
          The dashboard is fully data-driven — it automatically adapts to how the
          program is configured in <strong>Admin &rsaquo; Program Data</strong>.
        </p>
        <p>
          A single <strong>View</strong> selector at the top drives the whole
          page: a <strong>Level</strong> dropdown (Global / By Theatre / By Region
          / By Country, limited to the program&apos;s configured levels) plus a
          <strong> Value</strong> dropdown for the chosen level (which theatre /
          region / country; hidden for Global). Picking a scope shows the{" "}
          <strong>Tier Status</strong> (for tiered programs) and the one matching
          report for that scope.
        </p>

        <h3>Tier Status</h3>
        <p>
          Shown for <strong>tiered</strong> programs, above the report and
          following the page <strong>View</strong> scope (including By Region,
          aggregated across the region&apos;s countries). It shows the
          partner&apos;s <strong>highest tier achieved</strong> and progress toward
          the next one. Each tier card shows how many specialisations are achieved
          versus required (and <strong>lists which specialisations</strong> are
          currently achieved at that scope), plus any Deployment cert requirements
          with their distinct-holder counts (expand a requirement to see the
          per-theatre breakdown). With a &ldquo;Compliance as of&rdquo; horizon
          selected, the banner also shows the projected highest tier once expiring
          certs drop out.
        </p>

        <h3>Country &amp; Region Reports</h3>
        <p>
          Shown when the <strong>View</strong> level is By Country or By Region
          (available when the program has country-level requirements). A region
          aggregates all of its countries. Each column is a specialisation, with
          rows for the training name, required count, and attained count. Green
          means the requirement is met; red means it is not. Click{" "}
          <strong>View</strong> to list the qualifying students.
        </p>
        <p>
          Where a specialisation has <strong>Deployment requirements</strong> (tiered
          programs in <em>per-achieved-specialisation</em> mode), they appear in their own
          sub-section below the qualifying rows. A specialisation is still achieved on its
          qualifying requirements alone, but a tier that uses it also needs these
          deployment requirements — so they&apos;re shown here (with their own met/not-met
          state) rather than hidden. Exports gain a <strong>Purpose</strong> column
          (Qualification / Deployment).
        </p>

        <h3>Theatre Report</h3>
        <p>
          Shown when the <strong>View</strong> level is By Theatre (available when
          the program has theatre-level requirements). Pick a theatre to view its
          compliance.
        </p>

        <h3>Global Report</h3>
        <p>
          Shown when the <strong>View</strong> level is Global (available when the
          program has global-level requirements). Two presentations are supported
          automatically:
        </p>
        <ul>
          <li>
            <strong>Compliant-theatre count</strong> — when global rows have no
            specific training, the report shows how many theatres meet all of a
            specialisation&apos;s theatre-level requirements, against a target
            number of compliant theatres.
          </li>
          <li>
            <strong>Global count with per-theatre minimums</strong> — when a
            requirement has a per-theatre minimum, each specialisation appears as
            a card with a global attained/required total and an expandable
            per-theatre breakdown. The requirement is only met when the global
            total is reached <em>and</em> every theatre meets its minimum.
          </li>
        </ul>

        <h3>Alternative Trainings</h3>
        <p>
          If a requirement has alternative trainings configured (OR logic), they
          appear below the primary training name in blue text. Attained counts
          reflect students with <em>any</em> of the accepted trainings (primary
          or alternatives), deduplicated by student.
        </p>

        <h3>Compliance as of (expiry projection)</h3>
        <p>
          The <strong>Compliance as of</strong> selector in the header lets you
          look ahead to see how upcoming certificate expiry will affect
          compliance. Choose <strong>+3</strong>, <strong>+6</strong>, or{" "}
          <strong>+12 months</strong> and every section recomputes compliance as
          it will stand on that future date — any certificate expiring within the
          window simply drops out of the count.
        </p>
        <ul>
          <li>
            Attained figures are shown as <strong>current → projected</strong>{" "}
            (e.g. 5 → 3), with a <em>▼N expiring</em> note for the number of
            people whose qualifying certificate lapses within the window.
          </li>
          <li>
            Items shaded <strong>amber</strong> (and an <em>At Risk</em> status)
            are compliant today but will fall below their requirement by the
            selected horizon — your early warning to schedule renewals.
          </li>
          <li>
            Green stays compliant through the horizon; red is already
            non-compliant today. Set the selector back to <strong>Now</strong> to
            return to a present-day snapshot.
          </li>
        </ul>

        <h3>Export</h3>
        <p>
          Each report section has an Export button to download the compliance
          data (including theatre breakdowns where present) as CSV, Excel, or
          PDF. When a projection horizon is selected, the export adds{" "}
          <strong>projected</strong>, <strong>expiring</strong>, and{" "}
          <strong>projected-compliant</strong> columns reflecting that horizon.
        </p>
      </>
    ),
  },
  "admin-product-types": {
    title: "Product Types",
    content: (
      <>
        <p>
          Product types are an admin-managed list used to categorise training
          data (for example on the dashboard&apos;s &quot;By Product Type&quot;
          chart and the By Product Type report). Add, rename, or remove the
          product types that fit your catalogue.
        </p>

        <h3>Adding &amp; Renaming</h3>
        <p>
          Use <strong>Add Product Type</strong> to create a new entry. Names must
          be unique (case-insensitive). Renaming a product type updates it
          everywhere it is referenced.
        </p>

        <h3>Colour</h3>
        <p>
          Each product type can be given an optional brand colour. Pick one with
          the saturation/hue picker or type a hex value such as{" "}
          <code>#1a2b3c</code>. Charts that represent products use the colour
          automatically: the dashboard and By Product Type chart colour each
          product&apos;s X-axis label, while the Coverage and Comparison
          (&quot;By Product&quot;) charts colour each product&apos;s series.
          Product types without a colour fall back to a neutral grey, so any
          unconfigured product is visually obvious.
        </p>

        <h3>Deleting</h3>
        <p>
          A product type can only be deleted when no training data references it.
          The <strong>Trainings</strong> column shows the current usage count;
          reassign those trainings to another product type first.
        </p>

        <h3>Import &amp; Export</h3>
        <p>
          Use <strong>Import Product Types</strong> to bulk-create entries from a
          CSV or Excel file with a <code>Name</code> column and an optional
          <code> Color</code> column (hex value like <code>#1a2b3c</code>). The
          wizard auto-maps the columns, shows a preview, and reports how many
          were created, updated (existing row given a new colour), or skipped.
          Invalid colour cells are reported and the row is imported without a
          colour. <strong>Export</strong> downloads the current list (including
          colour) as CSV, Excel, or PDF.
        </p>

        <h3>Training-data imports</h3>
        <p>
          During a training-data import, product-type cells are matched
          case-insensitively against this list. Unknown values are reported as
          per-row errors rather than being silently changed, so keep this list in
          sync with the values used in your spreadsheets.
        </p>
      </>
    ),
  },
  "admin-specialisations": {
    title: "Specialisations",
    content: (
      <>
        <p>
          Specialisations are the building blocks of partner programs. Each
          specialisation groups the training requirements a partner must meet,
          and tiered programs unlock tiers based on how many specialisations a
          partner has achieved. This page manages the master list.
        </p>

        <h3>Adding &amp; Renaming</h3>
        <p>
          Use <strong>Add Specialisation</strong> to create a new entry. Names
          must be unique. Renaming a specialisation updates it everywhere it is
          referenced (program requirements, tiers, and compliance dashboards).
          You can also still add a specialisation inline from the program-data
          requirement editor — both routes feed the same list.
        </p>

        <h3>Searching &amp; Filtering</h3>
        <p>
          Use the search box to find a specialisation by name. The filter
          switches between <strong>All</strong>, <strong>In use</strong>{" "}
          (referenced by at least one program requirement), and{" "}
          <strong>Unused</strong>. Click a column header to sort by name or by
          usage count.
        </p>

        <h3>Deleting</h3>
        <p>
          A specialisation can only be deleted when no program requirement
          references it. The <strong>Used by programs</strong> column shows the
          current usage count; remove or reassign those requirements first.
        </p>

        <h3>Import &amp; Export</h3>
        <p>
          Use <strong>Import Specialisations</strong> to bulk-create entries
          from a CSV or Excel file with a single <code>Name</code> column. The
          wizard auto-maps the column, shows a preview, and reports how many were
          created or skipped (names that already exist are skipped).{" "}
          <strong>Export</strong> downloads the current list as CSV, Excel, or
          PDF.
        </p>
      </>
    ),
  },
  "api-keys": {
    title: "API Keys",
    content: (
      <>
        <p>
          API keys let trusted third-party systems read your data through the
          <strong> read-only public API</strong>. Each key is scoped to one or more
          companies and can only <em>read</em> — there is no way to create, change,
          or delete data with a key. This page is SuperAdmin-only.
        </p>

        <h3>Turning the API on and off</h3>
        <p>
          The banner at the top of this page is a <strong>single switch for the whole
          public API</strong>, separate from the individual keys below. It ships
          <strong> switched off</strong>: until you click <strong>Enable API</strong>,
          every request to <code>/api/public/v1</code> is refused with an HTTP
          <strong> 503</strong>, no matter how many valid, active keys exist.
        </p>
        <ul>
          <li>Use it as a <strong>kill switch</strong> — turning the API off stops all external access at once, without touching your keys, so switching it back on restores access with no re-issuing.</li>
          <li>The switch always wins: while the API is off, a key showing <em>Active</em> in the table below still can&rsquo;t be used.</li>
          <li>Changes take up to <strong>30 seconds</strong> to take effect, because the setting is briefly cached.</li>
        </ul>

        <h3>Creating a key</h3>
        <ul>
          <li>Click <strong>New API Key</strong>, give it a descriptive name (e.g. &ldquo;Partner CRM sync&rdquo;), and tick the companies it may read.</li>
          <li>Optionally set an <strong>expiry</strong> date; leave it blank for a key that never expires.</li>
          <li>The full key is shown <strong>once</strong>, immediately after creation. Copy it and store it somewhere safe — it is hashed in the database and can never be displayed again. If it&rsquo;s lost, delete the key and create a new one.</li>
        </ul>

        <h3>Using a key</h3>
        <p>
          The calling system sends the key in an <code>Authorization: Bearer &lt;key&gt;</code>
          header (an <code>X-API-Key</code> header is also accepted) over HTTPS. Available
          endpoints:
        </p>
        <table>
          <thead>
            <tr><th>Endpoint</th><th>Returns</th></tr>
          </thead>
          <tbody>
            <tr><td><code>GET /api/public/v1</code></td><td>Index — confirms the key works and lists its companies and the available endpoints.</td></tr>
            <tr><td><code>GET /api/public/v1/students</code></td><td>Student roster for the key&rsquo;s companies.</td></tr>
            <tr><td><code>GET /api/public/v1/training-records</code></td><td>Per-completion training records (latest per learner &amp; training).</td></tr>
            <tr><td><code>GET /api/public/v1/reports/&#123;type&#125;</code></td><td>Report aggregates (e.g. <code>expiring-soon</code>, <code>legacy-gap</code>, <code>learner-scorecard</code>).</td></tr>
            <tr><td><code>GET /api/public/v1/programs</code></td><td>Partner program list (levels, per-theatre-minimum flag, tiered flag).</td></tr>
            <tr><td><code>GET /api/public/v1/programs/&#123;name&#125;</code></td><td>Per-program compliance — <code>?level=</code>, <code>?horizonMonths=</code>, and <code>?trainingTitle=&amp;students=true</code> for the holder roster.</td></tr>
          </tbody>
        </table>
        <p>
          All endpoints accept an optional <code>?companyId=</code> to narrow to a single
          granted company. A request for a company the key cannot read returns no rows.
        </p>

        <h3>Managing &amp; securing keys</h3>
        <ul>
          <li><strong>Disable</strong> temporarily suspends a key; <strong>Revoke</strong> permanently kills it (a revoked key can never be re-enabled).</li>
          <li><strong>Edit</strong> renames a key, changes its companies, or adjusts its expiry. <strong>Delete</strong> removes it entirely.</li>
          <li>The <strong>Last used</strong> column shows when the key last made a request, so unused keys are easy to spot and clean up. The <strong>Last IP</strong> column shows the source IP of that request (from the <code>X-Forwarded-For</code> header), so you can confirm traffic is coming from where you expect.</li>
          <li>Each key is rate-limited (120 requests per minute); excess requests receive an HTTP 429. Requests made with an invalid or unknown key are separately throttled per IP (20 failures per 5 minutes), so the API can&rsquo;t be sprayed with key guesses.</li>
          <li>The <strong>Failed API attempts</strong> panel below the table shows recent rejected requests &mdash; a masked prefix of the key that was tried (plus its name if it matched a known disabled/revoked/expired key), the source IP, the reason, and the time. Use <strong>Unblock IP</strong> to lift the throttle on an address. The log is kept for 30 days.</li>
          <li>Treat keys like passwords: only stored as a hash, never logged, and best sent server-to-server rather than from a browser.</li>
        </ul>
      </>
    ),
  },
};

export function getHelpContent(slug: string): HelpSection | null {
  return helpSections[slug] ?? null;
}
