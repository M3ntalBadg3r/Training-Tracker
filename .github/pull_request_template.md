## What this changes

<!-- One or two sentences. What was wrong or missing, and what this does about it. -->

## Why

<!-- The reason, not the diff. What breaks or stays broken without this? -->

---

### Post-change rules (CLAUDE.md)

Tick what applies; strike out what genuinely does not. `release-hygiene` checks
the first two mechanically — the rest are yours.

- [ ] **Version left alone** — merging into `dev` publishes nothing, so an
      ordinary task does not touch it. *Only* tick the one below instead if this
      PR is preparing a stable release.
- [ ] **If preparing a stable release:** `package-lock.json`'s two `version`
      fields match `package.json`, and notes are written to
      `.github/releases/v<version>.md`. Draft them with
      `npm run notes:draft -- --from <last stable tag>`, then **edit** — the raw
      draft is merged PR titles, not a changelog. No label needed.
- [ ] **`README.md` updated** — or not needed, because this does not change how
      the system is used.
- [ ] **`src/lib/help-content.tsx` updated** — or not needed, because no
      user-facing behaviour changed.
- [ ] **`CLAUDE.md` updated** — or not needed, because neither the project
      structure nor the data model changed.
- [ ] **De-identified.** No real company, customer, partner, product,
      certification or partner-program names, and no PII, in the diff *or* in
      the release notes. Placeholders only: `Jane Doe`, `jane.doe@co.com`,
      `Product A`, `Cert A`, `EMEA`/`NAM`/`JAPAC`/`LATAM`.
      *(The `deidentify` check blocks, but only spots email domains and
      home-directory paths — names are a human check, and passing it is not a
      de-identification review. Label `skip-deid-scan` to override a false
      positive.)*
- [ ] **This PR's title is safe to publish.** It becomes a line in the drafted
      release notes for whichever release picks this change up, and nothing
      scans PR titles.

### Security

- [ ] **Not security-relevant** — this change does not touch authentication or
      authorisation, an externally reachable surface, a privilege boundary, a
      sink (filesystem / shell / outbound request / HTML / export), a
      credential, backup or export contents, or a runtime dependency.
- [ ] **Or: it is**, and it was held to the obligations in `CLAUDE.md`
      → *Writing a route handler*. If it introduces a **new surface** of any of
      those kinds, an audit is due — see `SECURITY.md`.

*A green pipeline is not a security review: the checks encode failures already
found. Real customer, partner, product and program names in particular are a
human check and nothing else.*

### Merge

- Into `dev`: **squash**.
- Into `master` (stable promotion): **merge commit**, never squash — the
  `git merge --ff-only master` invariant in CLAUDE.md depends on it.
