# Plan — Geographic map visualisation, piloted on the Offering dashboard

**Status:** planning only, nothing built.
**Grounded against:** `origin/dev` @ `7be13bb` (v3.31.0).
**Scope of this document:** build a reusable geographic-map capability and land its
first consumer on `/offerings/[offeringName]`. Every layer is designed to be used
again elsewhere without being rewritten.

---

## 1. Why the Offering dashboard first

Of everything in the app that carries geography, the offering dashboard is the
only place where the geography **is the subject** rather than a filter.
`src/lib/offering-compliance.ts:1-14` defines the three bands as country-set
operations:

- **Onshore** — the selected country, or the selected region's countries.
- **Nearshore** — the rest of that theatre, minus onshore.
- **Offshore** — every country worldwide, minus onshore (a superset of nearshore).

Today that renders as three numeric columns
(`src/app/offerings/[offeringName]/page.tsx:267-269`) plus a prose line counting
countries (`:231`). The user has to hold a world map in their head to answer
"can we deliver this in-country, or are we leaning on offshore?".

Two further reasons it is the right pilot:

1. **The band map needs no new server work.** The API already returns
   `geo.onshoreCountries` / `nearshoreCountries` / `offshoreCountries` to the
   client (`src/app/api/offerings/[offeringName]/route.ts`, `geo: geoOut`). Phase 2
   below is therefore purely client-side — no new endpoint, no new query, no new
   security surface.
2. **It is small enough that a missing country is obvious.** The ISO groundwork
   (§3) gets proven on one page where an unmapped country is visible, rather than
   buried in a multi-row compliance matrix.

Everything else that could take a map (program compliance at Country level, the
Comparison report, expired/lapsed distribution) is a **later consumer of the same
three layers**, not a separate build. §8 covers that.

---

## 2. Architecture — three independent layers

The reusability comes from splitting this into three layers that can each be
adopted alone. Nothing about layers 2 and 3 knows anything about offerings.

| Layer | What it is | Lives in | Reused by |
|---|---|---|---|
| **1. Geo identity** | `RegionData.isoCode` — the join key from a free-text country name to a geometry | `prisma/schema.prisma`, `/admin/region-data`, `/api/region-data/*` | every map, and useful on its own as data quality |
| **2. Per-bucket counting** | generalise the existing theatre-bucketed holder count to any geo bucket | `src/lib/program-compliance.ts` | offerings, programs, any future per-country metric |
| **3. Presentation** | `GeoMap` — a data-agnostic, ISO-keyed inline-SVG choropleth | `src/components/geo/` | every map consumer |

**The offering dashboard is consumer #1, not the owner of any of it.**

---

## 3. Layer 1 — `RegionData.isoCode`

### The problem it solves

There is no geographic key anywhere in the data model. `RegionData` is:

```prisma
model RegionData {
  country  String    @id
  region   String
  theatre  String?
}
```

Three free-text strings, imported from a spreadsheet
(`src/app/admin/region-data/page.tsx:26-28`). No ISO codes, no coordinates —
confirmed by grep across all of `src/`.

Any map needs a join from that free-text name to a geometry, and **that join fails
silently**: "UK" vs "United Kingdom", "US"/"USA"/"United States", "Korea, Republic
of". An unmatched country does not error — it simply is not drawn, and the map
quietly under-reports.

### Design

- **Column:** `isoCode String? @map("iso_code") @db.VarChar(2)`.
- **Constraint:** a CHECK for `^[A-Z]{2}$`, following the `ProductType.color`
  precedent (a CHECK for `#RRGGBB` lowercase). ISO 3166-1 **alpha-2**, uppercase.
- **Deliberately NOT unique.** Two rows legitimately share a code: a sales
  geography may carry "England" and "Scotland" as separate countries, both `GB`.
  Forcing uniqueness would make the admin unable to record a real geography.
  **Consequence for Layer 3: the map must aggregate rows sharing an ISO** — sum the
  values, and list every contributing country name in the tooltip.
- **Nullable, and null is a first-class state.** A country with no code is
  *unmapped*, which is reported (§6.2), never dropped.

### Sites to change

| Site | Change |
|---|---|
| `prisma/schema.prisma` + a migration | add the column + CHECK |
| `src/app/admin/region-data/page.tsx` | column in the table, field in add/edit, in the CSV/Excel/PDF export, in the import column mapping |
| `src/app/api/region-data/route.ts` (POST) | accept + validate `isoCode` |
| `src/app/api/region-data/[country]/route.ts` (PUT) | same |
| `src/app/api/region-data/import/route.ts` | see the non-destructive rule below |
| `src/app/api/region-data/countries/route.ts:15-18` | add `isoCode` to the `select` |
| `src/hooks/useRegionData.ts` | add `isoCode` to `RegionDataRow` |

### Two traps, both with existing precedent in this repo

**An unmapped import column must write nothing.** The region-data import already
gets this right for `theatre` (`import/route.ts:65-79`): when `columnMapping.theatre`
is absent it neither compares nor writes it, so a file without that column leaves
the stored value alone. `isoCode` must mirror that exactly. The training-data
import's `Legacy`/`Replacement` columns are the documented example of what happens
when it is not done — importing a file without the column silently cleared the
value on every row it touched.

**Backups ride along for free — but verify rather than assume.** `region_data.json`
is a rest-spread `findMany()` (`backup/route.ts:295` full, `:409` config), so a new
column is included automatically; the full restore's `createMany`
(`:829`) and the config restore's `upsert` (`:1218`) need no change, and older
archives lacking `iso_code` restore as null. **Test both restore paths against a
pre-change archive** before calling this done.

### Populating the codes

Operator-maintained by default: a column in Region Data, dull and honest.

An optional "suggest ISO codes" helper that name-matches the existing countries is
reasonable **only as a review queue, never auto-apply**. An auto-match is a new
silent-mismatch surface, which is precisely the failure mode this column exists to
eliminate. Flagged as an open decision (§10).

---

## 4. Layer 2 — per-bucket holder counts

Only needed for the *density* map (Phase 3). The band map (Phase 2) needs none of
this.

### What exists

`getEmailSetsByTitle(titles, asOf, scope)` (`program-compliance.ts:144`) unions
holders across a **country set** — it cannot tell you the per-country split.
`getEmailSetsByTitleAndTheatre(titles, asOf, companyIds)` (`:196`) is the same
query with one extra `select` of the geo field, grouped by bucket. It is the exact
precedent for what a per-country breakdown needs.

### The reusable move

Do **not** add a third near-identical function. Generalise:

```ts
type GeoBucket = "theatre" | "country";

export async function getEmailSetsByTitleAndGeo(
  trainingTitles: string[],
  asOf: Date,
  bucket: GeoBucket,
  scope: ComplianceScope = {},
): Promise<Map<string, Map<string, Set<string>>>>;
```

- `getEmailSetsByTitleAndTheatre` becomes a thin wrapper, so its existing call
  sites are untouched.
- `unionAttainedByTheatre` (`:266`) generalises the same way to
  `unionAttainedByGeo`.
- **Take a full `ComplianceScope`, not just `companyIds`.** The theatre variant
  only accepts `companyIds`, and the offering map needs to bucket by country
  *within* the onshore/nearshore/offshore country list — a capability gap today.

### Invariants to preserve and state

- **Empty company scope matches nothing.** `getEmailSetsByTitle` returns an empty
  map on `companyIds.length === 0` (`:150`) and the filter is applied as
  `length > 0 ? {in: ids} : {}`. The generalised function must keep both. An empty
  array is "may read no companies", `null`/`undefined` is "unrestricted".
- **Per-country counts sum to the band total, and that is load-bearing.**
  `Student.country` is a single column and `unionAttained` counts distinct emails,
  so the per-country partition is clean. If a student ever gains multiple
  countries, every per-country map silently starts double-counting. Worth a
  comment at the bucketing site.
- **Point-in-time semantics are inherited, not reinvented** — the `completedDate <= asOf`
  / `expiryDate > asOf` pair and `resolveSiblingTitles` expansion come along with
  the shared query.

---

## 5. Layer 3 — the `GeoMap` component

### Where the geometry comes from

No new runtime dependency. Recharts has no geographic projection, and a
canvas/WebGL map library would be **silently omitted from every PDF export** (see
§7). Instead: a pre-simplified, pre-projected, ISO-keyed SVG committed as a static
asset.

- **Asset:** `public/geo/world-countries.json` — `{ viewBox, paths: { [iso2]: d } }`.
  Served as a static file and fetched on mount, so it stays out of every JS bundle
  that imports the component.
- **Projection:** Equal Earth or Robinson. **Not Mercator** — it grossly inflates
  high latitudes, which is a correctness problem when the map's whole job is
  "where are our people".
- **Source:** generated once from a public-domain dataset (Natural Earth is public
  domain; world-atlas TopoJSON is ISC) by a one-off script that is *not* committed
  as a dependency. Record the source and licence in a header alongside the asset.
- **Loading:** via `useFetchJson` — the documented shape for "fetch one URL into
  one blob of state", which also satisfies `react-hooks/set-state-in-effect` and
  brings a cancellation guard.

### The interface — this is the reusability contract

```ts
export interface GeoMapDatum {
  /** ISO 3166-1 alpha-2, uppercase. The join key. */
  iso: string;
  /** Display label(s) — the app's own country name(s), not the atlas's. */
  labels: string[];
  /** Drives the fill in "sequential" mode. null = no data, which is NOT zero. */
  value: number | null;
  /** Discrete band, for "categorical" mode. */
  band?: string;
}

export interface GeoMapProps {
  data: GeoMapDatum[];
  mode: "sequential" | "categorical";
  /** Categorical fills + legend. Ignored in sequential mode. */
  bands?: { key: string; label: string; color: string }[];
  /** Sequential legend title, e.g. "Active holders". */
  valueLabel?: string;
  /** Countries in RegionData with no isoCode. Rendered by the component. */
  unmapped?: string[];
  /** Emits both the code and the app's country name. */
  onSelect?: (iso: string, labels: string[]) => void;
  selected?: string | null;
  height?: number;
}
```

Four choices here are what make it reusable rather than offering-specific:

1. **`value: number | null`, where null ≠ 0.** A country with no data must render
   differently from a country with zero holders. Same principle as the
   `filterOptions` → `useRegionData` change: offer the country and return an honest
   empty result rather than being silently absent.
2. **`mode` + optional `band`.** One component serves the offering's three-band
   map, a program-compliance status map (compliant / at-risk / non-compliant) and
   a sequential holder-density map, with no new component.
3. **`unmapped` is part of the contract and the component renders the notice.** No
   consumer can forget it.
4. **`onSelect` emits the app's country name, not just the ISO code.** Consumers
   key their scope state on the country name (`GeoScopeFilter`'s
   `{theatre, region, country}`, the offering dashboard's `value`), so the
   component hands back what they actually need. `labels` is an array because ISO
   codes are not unique in `RegionData` (§3).

### Rendering constraints that are not negotiable

Driven by the PDF capture pipeline (`src/lib/chart-capture.ts`), verified:

- **Flat per-path `fill` only. No gradients, no pattern fills.** `inlineStyles`
  skips any computed value starting with `url(` (`:117`), so a gradient fill
  captures as nothing.
- **No `clip-path`, `mask` or `filter`.** They are deliberately absent from
  `INLINE_PROPS` (`:57-64`) because their computed forms absolutize to unresolvable
  URLs. Clip by pre-cropping the path data instead.
- **The legend must live inside the `<svg>`.** The legend redraw only reads
  `.recharts-legend-item` (an HTML node Recharts emits), so an HTML legend beside
  the map is absent from the PDF.
- **Resolve fills at render, never in a memoised feature array.** This is the
  documented Recharts pitfall applied to the map: a theme-dependent colour inside
  the data array changes the array's identity when `ForceLightChartsContext` flips,
  which restarts animation and photographs a half-drawn chart. **Memoise geometry,
  not colour.** All colours come from `useChartTheme()` so the light-palette flip
  works with no special casing.

---

## 6. Honesty constraints

These are correctness requirements, not polish. Each one is a way the map can lie.

### 6.1 A per-country map is a distribution map, NOT a compliance map

`met` is computed on the onshore set **as a whole**:
`req.met = c.onshore >= req.quantityRequired`
(`api/offerings/[offeringName]/route.ts`). Three holders spread across three
countries satisfy a `quantityRequired: 3` requirement that **no single country
meets**.

So: colouring countries on a red/green scale would read as per-country compliance
and be false. The density map's legend says *holders*, met/not-met stays where it
is today (the table and the per-specialisation badge), and the map carries a
one-line note saying the requirement is met by the geography collectively.

### 6.2 Unmapped countries are stated, never dropped

A count plus an expandable list of `RegionData` countries with no `isoCode`,
rendered by `GeoMap` itself, and carried into the PDF/CSV export. This follows the
`PendingReviewNotice` precedent — a notice that reports an ongoing inaccuracy in
the numbers on the same screen, deliberately not dismissible.

### 6.3 The bands overlap by design, so one map cannot fill a country twice

Offshore is a **superset** of nearshore (`offering-compliance.ts:1-14`). A single
choropleth cannot give a country two fills. Two honest options — an open decision
(§10):

- **(a)** One map, three mutually exclusive fills: onshore / nearshore /
  rest-of-world, with the legend stating that offshore = nearshore ∪ rest-of-world.
- **(b)** Small multiples: three maps, each highlighting one band as it is actually
  defined, at the cost of space.

Recommendation: **(a)**, because the question the page answers is "how far away is
our delivery capability", which one picture answers better than three.

---

## 7. Other constraints from this codebase

- **PDF export works for free — but only with inline SVG.** `findSurface`
  (`chart-capture.ts:88-96`) falls back to *any* `<svg>` in the card when no
  `.recharts-surface` exists, and `INLINE_PROPS` already whitelists
  `fill`/`stroke`/`opacity`. So a plain inline SVG inside `ExportableChart` is
  captured. A canvas or WebGL map captures as **null**, and every capture failure
  path returns null by design — the chart would be silently missing from the PDF.
- **Wrap the card, not the SVG.** `ExportableChart` goes around the whole chart
  card so the `<h3>` stays inside and the title is read from the DOM at capture
  time.
- **This turns the export chart tickbox on for the first time on this page.** The
  offering dashboard has no `ExportableChart` today, and `ui/ExportMenu` shows
  "Include charts & metrics in PDF" only when `chartCount > 0`. The offering page
  uses `ProgramCompliance`'s `ExportMenu`, which is an adapter over `ui/ExportMenu`.
  So the export path must be **exercised end to end**, not assumed.
- **View state must be mirrored to the URL.** The dashboard already mirrors
  `level`/`value` and re-emits `companyId` verbatim from `searchParams` (never the
  derived value — writing the derived one pins the page to a company). A map/table
  view toggle is new view state and must be mirrored and re-validated on read;
  `npm run check:url-state` fails CI otherwise.
- **A map click drives the existing scope state.** It sets `level`/`value`, not a
  parallel selection. One source of truth, and the URL mirror comes along free.
- **No new runtime dependency**, by design — which also keeps this clear of
  `CLAUDE.md` rule 7's dependency trigger and of the standing `npm audit`
  exceptions.
- **`/api/offerings/[offeringName]` is not currently cached** (no `cachedReport`).
  Phase 3 adds one query of the same shape as the three it already runs; measure
  before reaching for `report-cache.ts`, and if it is added the key must encode the
  company scope **and** level/value.

---

## 8. Extending it later (the point of the layering)

Each of these is a new consumer, not a new build:

| Consumer | Mode | New work |
|---|---|---|
| **Program compliance, Country level** | categorical (compliant / at-risk / non-compliant) | map `ComplianceTable` rows to `GeoMapDatum.band`; reuse `riskState`/`RISK_BADGE` for the amber state rather than inventing a scale. One map per specialisation — a single map cannot carry the matrix. |
| **Comparison report** | sequential | already computes a per-geography metrics matrix with `geoMode: country`. **Graduated symbols, not fills** — choropleth area misleads for counts, and these are quantities users rank. Keep the existing chart as the default view. |
| **Expired / lapsed by country** | sequential | `expired-report.ts` already buckets by theatre; bucket by country via Layer 2. |
| **Expiring Soon** | sequential + horizon | lower value — the existing theatre×month heatmap already answers "which region faces a cluster" well. |

**Explicitly not worth a map:** dashboard KPIs, by-product-type, by-function,
catalogue-health, legacy-gap, learner-scorecard, last-12-months,
program-compliance-trend, renewal-forecast. In all of these geography is a
*filter*, not the subject. Also **nothing at theatre level** — a map of five shapes
is a worse bar chart. Maps earn their place at country granularity.

---

## 9. Phases

Each phase is its own PR into `dev`, and each is independently useful.

### Phase 1 — Layer 1: `isoCode` (no map yet)
Schema + migration + CHECK, admin CRUD, import (non-destructive rule), export,
`countries` route + `useRegionData`, backup/restore verification against a
pre-change archive. **Ships alone as a data-quality improvement.**

### Phase 2 — Layer 3 + the band map (no server changes at all)
`public/geo/world-countries.json`, `components/geo/GeoMap.tsx`, the atlas loader,
and the offering band map wired to the `geo.*Countries` arrays the API **already
returns**. Map/table view toggle mirrored to the URL; `ExportableChart` wrapper;
unmapped-country notice. No new endpoint, no new query, no new security surface.

### Phase 3 — Layer 2 + the density map
Generalise to `getEmailSetsByTitleAndGeo`/`unionAttainedByGeo`, wrapper keeps the
theatre call sites unchanged, extend the offering response with a per-country
holder breakdown, add the sequential mode. Carries §6.1's distribution-not-compliance
labelling.

### Phase 4 — prove the reuse (optional, later)
Wire program compliance at Country level as consumer #2. If this needs changes to
`GeoMap`'s interface, the contract in §5 was wrong — that is the test.

---

## 10. Open decisions

1. **ISO codes: operator-maintained, or auto-matched with a review queue?** (§3)
   Recommendation: operator-maintained in Phase 1; revisit the helper only if the
   country list proves large enough to be painful.
2. **Band map: one map with three exclusive fills, or three small multiples?** (§6.3)
   Recommendation: one map, option (a).
3. **Does the map replace the three-column table, or sit beside it?**
   Recommendation: **beside it.** The table is precise and exportable; the map is
   not. Default to the table, remember the choice in the URL.
4. **Should `isoCode` reach the public API?** `/api/public/v1/offerings` is
   company-scoped and GET-only. Out of scope for Phase 1 either way.

---

## 11. Security review (`CLAUDE.md` rule 7)

Checked against the listed shapes:

- **New externally reachable surface?** No, if the breakdown rides on the existing
  authenticated GET. Any new endpoint needs `requireAuth` + company scope and is
  enforced by `npm run check:routes` per exported handler.
- **Input reaching a sink?** Yes — `isoCode` is written to the DB and used to look
  up an SVG path. Validate `^[A-Z]{2}$` on write (CHECK **and** route) and treat it
  as untrusted on read, because rows may predate the constraint. **Never
  interpolate it into a DOM selector or element id unvalidated.**
- **Company scope?** Carried through Layer 2 unchanged, including the
  empty-array-matches-nothing rule (§4).
- **Runtime dependency?** None, deliberately.
- **Privacy.** Country-level granularity on a small cohort is closer to
  identifying individuals than a theatre aggregate. It does not widen access — the
  View-students drill-down already shows names to authorised users — but it is a
  **de-identification consideration for screenshots**: never put a real dataset's
  map in docs, help content or release notes.

Verdict: not a new surface; Phase 1 and 3 carry per-route obligations, Phase 2
carries none.

---

## 12. Mandatory post-change rules (per phase)

- **No version bump** — these are ordinary tasks. The version moves only when a
  release is cut.
- `README.md` — update when Phase 1 lands (a new Region Data column) and Phase 2
  lands (a new view).
- `src/lib/help-content.tsx` — the offering help entry needs the map explained,
  including §6.1's distinction and the unmapped-country notice.
- `CLAUDE.md` — Phase 1 changes the data model (`RegionData.isoCode`); Phases 2–3
  change the project structure (`src/components/geo/`, `public/geo/`) and
  `program-compliance.ts`'s exports. All three need an entry.
- De-identify the diff and any notes; use fictional placeholders.
- CI must pass unaided: `lint`, `typecheck`, `build`, `check:routes`,
  `check:url-state`, `check:jsx`, `check:version`, plus `release-hygiene` and
  `deidentify` on the PR.

## 13. How to verify

- **Phase 1** — round-trip a Region Data import/export with and without an ISO
  column and confirm an absent column changes nothing; restore a **pre-change**
  full archive and a pre-change config archive.
- **Phase 2** — export the page to PDF with the tickbox on and confirm the map and
  its legend both appear; repeat in dark mode (the capture flips to the light
  palette); set a scope, open a student record, press Back, confirm the view
  restores; check at phone width.
- **Phase 3** — confirm the per-country counts sum to the band total shown in the
  table for the same scope, and that a country with no holders renders distinctly
  from one with no data.
