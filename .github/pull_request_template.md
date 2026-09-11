## What this changes

<!-- One or two sentences. What was wrong or missing, and what this does about it. -->

## Why

<!-- The reason, not the diff. What breaks or stays broken without this? -->

---

### Post-change rules (CLAUDE.md)

Tick what applies; strike out what genuinely does not. `release-hygiene` checks
the first three mechanically — the rest are yours.

- [ ] **Version bumped by exactly 0.01** in `package.json` — one task, one bump,
      no skipped numbers.
- [ ] **`package-lock.json`'s two `version` fields** match `package.json`.
- [ ] **Release notes written** to `.github/releases/v<version>-dev.md` (or
      `v<version>.md` for a stable promotion, aggregating every dev pre-release
      since the last stable).
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

### Merge

- Into `dev`: **squash**.
- Into `master` (stable promotion): **merge commit**, never squash — the
  `git merge --ff-only master` invariant in CLAUDE.md depends on it.
