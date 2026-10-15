"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import FilterBar from "@/components/ui/FilterBar";
import { SELECT_CLASS } from "@/components/ui/FormControls";
import Modal from "@/components/ui/Modal";
import {
  Globe,
  Building2,
  MapPin,
  Map,
  Layers,
  Boxes,
  ExternalLink,
  Anchor,
  AlertTriangle,
} from "lucide-react";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import CompanyRequired, { useCompanyRequired } from "@/components/company/CompanyRequired";
import {
  ComplianceTable,
  SpecialisationCard,
  ExportMenu,
  GATES_HEADING,
  LoadingSpinner,
  MINIMUM_SOURCE_LABELS,
  POPULATION_KIND_LABELS,
  TierLadder,
  TRAINING_TYPE_LABELS,
  DEPLOYMENT_REQUIREMENTS_NOTE,
  RISK_COMPLIANCE_LABEL,
  RISK_STATUS_LABEL,
  RISK_TONE,
  alternativesText,
  attainedText,
  complianceRiskState,
  countModeLabel,
  countriesMetText,
  countryBreakdownLines,
  expiringText,
  isEachCountry,
  isMultiCountryScope,
  minimumGateText,
  riskState,
  tierGate,
  trainingTypeLabel,
  type AlternativeEntry,
  type Requirement,
  type Specialisation,
  type StudentEntry,
  type TierBlock,
  type TierDeploymentRequirement,
  type ViewStudentsFn,
} from "@/components/programs/ProgramCompliance";
import type {
  ReportCellValue,
  ReportDocument,
  ReportRichCell,
  ReportRowGroup,
  ReportSection,
  ReportTonedRow,
} from "@/lib/report-export";
import {
  ANCHORED_SCOPE,
  ANCHORED_SCOPE_LABEL,
  SCOPE_LEVELS,
  SCOPE_LEVEL_LABELS,
  SCOPE_VALUE_NOUN,
  LEVEL_LABELS,
  parseProgramViewLevel,
  scopeLevelOffered,
  type AnchoredMeta,
  type AnchoredPopulation,
  type ProgramViewLevel,
  type ReqLevel,
  type ScopeLevel,
} from "@/lib/program-levels";

interface ProgramMeta {
  levels: string[];
  hasMinimumPerTheatre: boolean;
  isTiered?: boolean;
  deploymentMode?: string;
  // Anchored programs only (see `lib/program-report.ts:buildAnchoredReport`).
  isAnchored?: boolean;
  anchorTheatre?: string;
  /** Requirement levels the anchored view does not evaluate (warned about). */
  ignoredLevels?: string[];
  anchored?: AnchoredMeta | null;
}

/** What the program list says about this program before any report is asked for. */
interface ProgramInfo {
  isAnchored: boolean;
  anchorTheatre: string | null;
}

/** A requirement level's label, falling back to the raw value. */
function levelLabel(level: string): string {
  return (LEVEL_LABELS as Record<string, string>)[level as ReqLevel] ?? level;
}

// ── URL round-trip for the view ──
// Scope and horizon are mirrored to the query string so Back from a student
// record restores the view (see the mirror effect below). Values read back are
// validated rather than trusted: the horizon must be one the selector can
// render, and a seeded scope is additionally checked against the program's own
// configured levels before it is accepted.

/** The "Compliance as of" options — a value outside this set has no option to render. */
const HORIZON_OPTIONS = [0, 3, 6, 12];

function parseHorizon(v: string | null): number {
  const n = parseInt(v ?? "", 10);
  return HORIZON_OPTIONS.includes(n) ? n : 0;
}

/** The prompt noun for a scope's value ("country set"), or "" for Global. */
function valueNoun(level: ScopeLevel): string {
  return level === "global" ? "" : SCOPE_VALUE_NOUN[level];
}

/** True when an ISO (YYYY-MM-DD) expiry date falls within the next 3 months. */
function isExpiringSoon(iso: string | undefined): boolean {
  if (!iso) return false;
  const expiry = new Date(iso);
  if (Number.isNaN(expiry.getTime())) return false;
  const threshold = new Date();
  threshold.setMonth(threshold.getMonth() + 3);
  return expiry <= threshold;
}

function ProgramDetailPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams<{ programName: string }>();
  const programName = useMemo(() => {
    try {
      return decodeURIComponent(params.programName);
    } catch {
      return params.programName;
    }
  }, [params.programName]);
  const apiBase = `/api/programs/${encodeURIComponent(programName)}`;

  const companyScope = useCompanyScope();
  // Compliance is reported for one company at a time, and the header switcher is
  // the only control that picks it. Under "All companies" the page asks for one
  // (`companyRequired` below) instead of quietly reporting on whichever company
  // sorted first while looking like it covered them all.
  //
  // This is a plain render-time derivation rather than the "adjust state while
  // rendering" reconcile it replaced, and the usual objection does not apply:
  // that pattern exists to preserve a value the *user* can edit afterwards, and
  // the page's own Company dropdown — the only thing that ever wrote this — is
  // gone. Nothing edits it now, so there is nothing to preserve.
  const companyRequired = useCompanyRequired();
  const companyId =
    companyScope.loading || companyScope.selected === "all" ? null : companyScope.selected;
  const companyQS = companyId !== null ? `&companyId=${companyId}` : "";

  // Forward-looking projection horizon (0 = today). When > 0 the dashboard shows
  // how compliance will stand once certs expiring within the window drop out.
  const [horizonMonths, setHorizonMonths] = useState(() => parseHorizon(searchParams.get("horizon")));
  const horizonQS = horizonMonths > 0 ? `&horizonMonths=${horizonMonths}` : "";

  // Mount-time snapshot of the scope the URL asked for. Held in state rather
  // than read from `searchParams` at the point of use because the mirror effect
  // below rewrites the URL, and the default-scope pass must weigh what the user
  // arrived with — not what this page has since written.
  const [urlScope] = useState(() => ({
    // `anchored` included: an anchored program's only view.
    level: parseProgramViewLevel(searchParams.get("level")),
    value: searchParams.get("scope") ?? "",
  }));

  const [meta, setMeta] = useState<ProgramMeta | null>(null);
  const [countries, setCountries] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [theatres, setTheatres] = useState<string[]>([]);
  const [countrySets, setCountrySets] = useState<string[]>([]);
  // The company the lists above were last loaded for. Country Sets are
  // per-company tenant data, so `countrySets` describes ONE company and is
  // stale between a header company switch and its refetch landing; this is
  // what lets the page tell "this company has no such set" apart from "the new
  // company's list has not arrived yet".
  const [listsCompanyId, setListsCompanyId] = useState<number | null>(null);
  // Whether the program is anchored, from the program list — read before any
  // report is requested, because an anchored program answers ONLY `level=anchored`
  // (every other level is a 400) and a non-anchored one never answers it.
  const [programInfo, setProgramInfo] = useState<ProgramInfo | null>(null);
  // The partner's configured target Country Set for the loaded company (from
  // the anchored metadata fetch), used as the default selection.
  const [defaultTargetSet, setDefaultTargetSet] = useState<string | null>(null);

  // Single page-level scope: a level plus (for non-global levels) a value. This
  // one selection drives BOTH the Tier Status block and the matching report,
  // which the API returns together in a single response per level.
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>(
    urlScope.level === null || urlScope.level === ANCHORED_SCOPE ? "global" : urlScope.level
  );
  const [scopeValue, setScopeValue] = useState(urlScope.level === ANCHORED_SCOPE ? "" : urlScope.value);
  // Anchored programs: the Country Set holding the partner's target countries.
  // The anchored view has no level to choose — this is its only selector.
  const [targetSet, setTargetSet] = useState(() => (urlScope.level === ANCHORED_SCOPE ? urlScope.value : ""));
  const [scopeInitialised, setScopeInitialised] = useState(false);


  // Student modal
  const [showStudents, setShowStudents] = useState(false);
  const [studentList, setStudentList] = useState<StudentEntry[]>([]);
  const [studentLoading, setStudentLoading] = useState(false);
  const [studentTitle, setStudentTitle] = useState("");
  // Which roster the modal shows: a requirement's holders, or the people
  // trained towards its certification who do not hold it. Transient UI state —
  // not mirrored to the URL, like the modal itself.
  const [studentMode, setStudentMode] = useState<"holders" | "trainedNotCertified">("holders");

  // Group the roster by the specific training each person holds, so the modal
  // shows one table per training (primary + each alternative/variant) rather
  // than a single table implying everyone holds the requirement's primary.
  // A person holding several of them is listed under EACH, with that
  // training's dates — filing them under only their latest made the
  // per-training counts disagree with the Trained But Not Certified report.
  const studentGroups = useMemo(() => {
    // NB: `Map` is shadowed by the lucide-react icon import, so use a plain object.
    const groups: Record<string, StudentEntry[]> = {};
    for (const s of studentList) {
      const holdings = s.holdings?.length
        ? s.holdings
        : [{ training: s.training ?? "—", completedDate: s.completedDate, expiryDate: s.expiryDate }];
      for (const h of holdings) {
        (groups[h.training] ??= []).push({ ...s, completedDate: h.completedDate, expiryDate: h.expiryDate });
      }
    }
    // Put the requirement's primary training first, then the rest A–Z.
    return Object.entries(groups).sort((a, b) => {
      if (a[0] === studentTitle) return -1;
      if (b[0] === studentTitle) return 1;
      return a[0].localeCompare(b[0]);
    });
  }, [studentList, studentTitle]);

  // Export menu (single — one report is shown at a time)
  const [showExport, setShowExport] = useState(false);

  // The views this program offers, in selector order (Global > Theatre > Region >
  // Country Set > Country). Each is offered only when the program carries rows
  // at its own level — "By Region" no longer rides on Country rows. "By Country
  // Set" additionally needs the selected company to own at least one set: sets
  // are per-company, so a company with none has nothing to pick from even when
  // the program carries CountrySet rows.
  const levelOffered = (l: ScopeLevel, levels: readonly string[]): boolean =>
    scopeLevelOffered(l, levels) && (l !== "countrySet" || countrySets.length > 0);
  const offeredLevels = SCOPE_LEVELS.filter((l) => levelOffered(l, meta?.levels ?? []));
  const listsCurrent = companyId !== null && listsCompanyId === companyId;
  const gdStyleGlobal = meta?.hasMinimumPerTheatre ?? false;
  const isTiered = meta?.isTiered ?? false;
  // An anchored program offers one view — its target countries within the
  // anchor theatre — in place of the level selector.
  const anchoredView = programInfo?.isAnchored === true;
  const anchorTheatre = programInfo?.anchorTheatre ?? meta?.anchorTheatre ?? null;
  const viewLevel: ProgramViewLevel = anchoredView ? ANCHORED_SCOPE : scopeLevel;
  const viewValue = anchoredView ? targetSet : scopeValue;
  // The Global card layout (per-theatre minimums) never applies to the anchored view.
  const globalCardsView = !anchoredView && gdStyleGlobal && scopeLevel === "global";

  const needsValue = anchoredView || scopeLevel !== "global";
  const valuesForLevel = (l: ScopeLevel): string[] =>
    l === "theatre"
      ? theatres
      : l === "region"
        ? regions
        : l === "countrySet"
          ? countrySets
          : l === "country"
            ? countries
            : [];
  const scopeValues = valuesForLevel(scopeLevel);
  const scopeMissing = needsValue && !viewValue;
  /** The prompt noun for the value the view still needs. */
  const promptNoun = anchoredView ? "target Country Set" : valueNoun(scopeLevel);

  // Initial load — fetch metadata + available countries/regions/theatres.
  // Re-runs on a header company switch: the theatre and Country Set lists are
  // company-scoped. The `cancelled` guard drops a response for a company the
  // header has since moved away from, so a slow reply can never pin the lists
  // (and `listsCompanyId`) to the wrong company.
  //
  // The program list is read first because an anchored program answers only
  // `level=anchored` and anything else is a 400 — so the metadata request has
  // to know which kind of program it is asking about. For an anchored program
  // the metadata request carries no set: the API then resolves the partner's
  // configured target set, which becomes the page's default selection.
  useEffect(() => {
    if (companyId === null) return;
    let cancelled = false;
    fetch("/api/programs")
      .then((r) => r.json())
      .then((list: { programs?: { name: string; isAnchored?: boolean; anchorTheatre?: string | null }[] }) => {
        const entry = (list.programs ?? []).find((p) => p.name === programName);
        const info: ProgramInfo = {
          isAnchored: entry?.isAnchored === true,
          anchorTheatre: entry?.anchorTheatre ?? null,
        };
        const level = info.isAnchored ? ANCHORED_SCOPE : "country";
        return fetch(`${apiBase}?level=${level}${companyQS}`)
          .then((r) => r.json())
          .then((data) => ({ info, data }));
      })
      .then(({ info, data }) => {
        if (cancelled) return;
        setProgramInfo(info);
        setCountries(data.countries || []);
        setRegions(data.regions || []);
        setTheatres(data.theatres || []);
        setCountrySets(data.countrySets || []);
        setDefaultTargetSet(data.meta?.anchored?.countrySet ?? null);
        setListsCompanyId(companyId);
        setMeta(data.meta || { levels: [], hasMinimumPerTheatre: false });
      })
      .catch(() => {
        // A failed load still settles the company-scoped lists, as loaded-empty
        // for this company — the same fallback the roster modal uses. Leaving
        // `listsCompanyId` unset would park a selected Country Set on
        // "unverified" for ever (a permanent spinner); marking the lists loaded
        // and empty lets the stale-set pass fall back to the default scope.
        // `meta`, countries and regions are not company data and are left as
        // they were.
        if (cancelled) return;
        setTheatres([]);
        setCountrySets([]);
        setDefaultTargetSet(null);
        setListsCompanyId(companyId);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, companyQS, apiBase, programName]);

  // Default the scope once we know which levels exist: pick the broadest
  // configured level (Global > Theatre > Region > Country Set > Country — the
  // `SCOPE_LEVELS` order, so a program carrying only Region or Country Set rows
  // still lands somewhere valid), and auto-select the first value for
  // value-requiring levels. Done while rendering (the `scopeInitialised` latch makes it
  // one-shot) rather than in an effect, since the user owns the scope after.
  // A scope seeded from the URL (back-navigation, a shared link) wins over that
  // default — but only once it has been checked against this program, which is
  // what `meta` arriving makes possible. A stale link naming a level the
  // program no longer configures, or a value no longer in its list, falls back
  // to the default rather than parking the page on a scope with no data.
  //
  // An anchored program has no level to default: the seed is a target set,
  // usable when the company owns it; otherwise the partner's configured target
  // set (if it is in the list), else nothing — and the page asks for one.
  const usableDefaultTarget = defaultTargetSet !== null && countrySets.includes(defaultTargetSet) ? defaultTargetSet : "";
  if (meta && !scopeInitialised && anchoredView && listsCurrent) {
    const seedUsable = urlScope.level === ANCHORED_SCOPE && countrySets.includes(urlScope.value);
    if (!seedUsable) setTargetSet(usableDefaultTarget);
    setScopeInitialised(true);
  }
  if (meta && !scopeInitialised && !anchoredView && meta.levels.length > 0) {
    const seedUsable =
      urlScope.level !== null &&
      urlScope.level !== ANCHORED_SCOPE &&
      levelOffered(urlScope.level, meta.levels) &&
      (urlScope.level === "global" || valuesForLevel(urlScope.level).includes(urlScope.value));
    if (!seedUsable) {
      const fallback = SCOPE_LEVELS.find((l) => levelOffered(l, meta.levels));
      if (fallback) {
        setScopeLevel(fallback);
        setScopeValue(fallback === "global" ? "" : valuesForLevel(fallback)[0] ?? "");
      }
    }
    setScopeInitialised(true);
  }

  // A Country Set belongs to one company, so switching the header company can
  // strand a selected set: the new company may own no set of that name. (A
  // same-named set over different countries is fine — the report is simply
  // that company's.) Once the new company's list has loaded, a selected set
  // missing from it falls back to the default scope, exactly as a stale link
  // does in the pass above. Adjusted while rendering, like that pass, rather
  // than in an effect; it converges because the fallback never yields a
  // countrySet value outside the list. An empty value is the user's own
  // "Select a country set…" choice and is left alone — unless the company owns
  // no sets at all, when "By Country Set" is no longer an option to sit on.
  const countrySetStale =
    !anchoredView &&
    scopeInitialised &&
    scopeLevel === "countrySet" &&
    listsCurrent &&
    (scopeValue === "" ? countrySets.length === 0 : !countrySets.includes(scopeValue));
  if (countrySetStale && meta) {
    const fallback = SCOPE_LEVELS.find((l) => levelOffered(l, meta.levels));
    if (fallback) {
      setScopeLevel(fallback);
      setScopeValue(fallback === "global" ? "" : valuesForLevel(fallback)[0] ?? "");
    }
  }
  // Until the current company's list has landed, a selected set cannot be
  // checked against it, so the report waits (it shows as loading) rather than
  // asking for a name the new company may not own.
  const countrySetUnverified =
    !anchoredView &&
    scopeLevel === "countrySet" &&
    scopeValue !== "" &&
    (!listsCurrent || !countrySets.includes(scopeValue));
  // The same two passes for an anchored program's target set: a set the newly
  // selected company does not own falls back to that company's configured
  // target set (or to asking for one), and an unchecked set waits.
  const targetSetStale =
    anchoredView && scopeInitialised && listsCurrent && targetSet !== "" && !countrySets.includes(targetSet);
  if (targetSetStale) setTargetSet(usableDefaultTarget);
  const targetSetUnverified =
    anchoredView && targetSet !== "" && (!listsCurrent || !countrySets.includes(targetSet));
  // The program has levels, but none this company can view — only possible when
  // its rows are all CountrySet and the company owns no sets.
  const noOfferedLevels =
    !anchoredView &&
    !companyRequired &&
    meta !== null &&
    meta.levels.length > 0 &&
    listsCurrent &&
    offeredLevels.length === 0;
  // An anchored program is reported over the partner's own target Country Set,
  // so a company with no sets has nothing to report on.
  const noTargetSets = anchoredView && !companyRequired && listsCurrent && countrySets.length === 0;

  const changeScopeLevel = (level: ScopeLevel) => {
    setScopeLevel(level);
    setScopeValue(level === "global" ? "" : valuesForLevel(level)[0] ?? "");
  };

  // Mirror the view to the URL so Back from a student record restores it.
  // Gated on `scopeInitialised` because until the default pass has run the
  // scope is provisional — writing it would mirror "global" over a seeded
  // level and defeat the very restore this exists for.
  const buildViewParams = useCallback(() => {
    const params = new URLSearchParams();
    if (anchoredView) {
      params.set("level", ANCHORED_SCOPE);
      if (targetSet) params.set("scope", targetSet);
    } else {
      params.set("level", scopeLevel);
      if (scopeLevel !== "global" && scopeValue) params.set("scope", scopeValue);
    }
    if (horizonMonths > 0) params.set("horizon", String(horizonMonths));
    return params;
  }, [anchoredView, targetSet, scopeLevel, scopeValue, horizonMonths]);

  useEffect(() => {
    if (!scopeInitialised) return;
    const qs = buildViewParams().toString();
    if (qs !== searchParams.toString()) {
      router.replace(`${pathname}?${qs}`, { scroll: false });
    }
  }, [scopeInitialised, buildViewParams, pathname, router, searchParams]);

  // Single scoped fetch — returns both the specialisations report and the tier
  // block for the selected scope. `loading` is derived by useFetchJson
  // (loadedKey !== requestKey) rather than written by a synchronous setState in
  // an effect; this also adds the out-of-order-response guard the old effect
  // lacked. A null url parks the hook without fetching, which is why `loading`
  // is masked by `scopeMissing` below — the render checks loading first, and an
  // incomplete scope must show the "pick a value" state, not a spinner.
  const reportUrl = (() => {
    if (companyId === null || !scopeInitialised || scopeMissing || countrySetUnverified || targetSetUnverified) {
      return null;
    }
    if (anchoredView) {
      const aqs = new URLSearchParams({ level: ANCHORED_SCOPE, countrySet: targetSet });
      return `${apiBase}?${aqs.toString()}${companyQS}${horizonQS}`;
    }
    const qs = new URLSearchParams({ level: scopeLevel });
    if (scopeLevel === "country") qs.set("country", scopeValue);
    else if (scopeLevel === "region") qs.set("region", scopeValue);
    else if (scopeLevel === "countrySet") qs.set("countrySet", scopeValue);
    else if (scopeLevel === "theatre") qs.set("theatre", scopeValue);
    return `${apiBase}?${qs.toString()}${companyQS}${horizonQS}`;
  })();
  const { data: reportData, loading: reportLoading } = useFetchJson<{
    specialisations?: Specialisation[];
    tiers?: TierBlock | null;
    meta?: ProgramMeta;
  }>(reportUrl);
  // `companyRequired` masks `loading` for the same reason `scopeMissing` does: a
  // null url parks useFetchJson at loading===true for ever, so without it the
  // gated page would sit on a spinner instead of showing the card asking for a
  // company.
  const loading = !companyRequired && !scopeMissing && reportLoading;
  const specs = useMemo(
    () => (scopeMissing ? [] : reportData?.specialisations ?? []),
    [scopeMissing, reportData]
  );
  const tierBlock = scopeMissing ? null : reportData?.tiers ?? null;
  // The anchored view's header: target countries, minimum and warnings.
  const anchoredMeta = anchoredView && !scopeMissing ? reportData?.meta?.anchored ?? null : null;
  const ignoredLevels = anchoredView ? reportData?.meta?.ignoredLevels ?? meta?.ignoredLevels ?? [] : [];

  const rosterRequestRef = useRef(0);
  const openRoster = async (
    mode: "holders" | "trainedNotCertified",
    trainingTitle: string,
    trainingFullTitle: string,
    level: string,
    filterValue: string,
    alternatives?: AlternativeEntry[],
    population?: AnchoredPopulation
  ) => {
    // Two roster modes share one modal, so a slower response for the mode the
    // user clicked first must not land under the title of the one they
    // clicked second. Only the latest request may write the list.
    const requestId = ++rosterRequestRef.current;
    setStudentMode(mode);
    setStudentTitle(trainingFullTitle);
    setStudentLoading(true);
    setShowStudents(true);
    setStudentList([]);

    const allTitles = [trainingTitle, ...(alternatives || []).map((a) => a.trainingTitle)].filter(Boolean);
    const params = new URLSearchParams({
      students: "true",
      trainingTitle: allTitles.join(","),
      level,
    });
    if (mode === "trainedNotCertified") params.set("trainedNotCertified", "true");
    if (level === "country") params.set("country", filterValue);
    if (level === "region") params.set("region", filterValue);
    // An anchored view resolves the partner's target set too, and names the
    // requirement's population so the roster matches the row's own figure.
    if (level === "countrySet" || level === ANCHORED_SCOPE) params.set("countrySet", filterValue);
    if (level === ANCHORED_SCOPE && population) params.set("population", population);
    if (level === "theatre") params.set("theatre", filterValue);
    if (companyId !== null) params.set("companyId", String(companyId));

    try {
      const res = await fetch(`${apiBase}?${params}`);
      const data = await res.json();
      if (requestId !== rosterRequestRef.current) return;
      setStudentList(data.students || []);
    } catch {
      if (requestId !== rosterRequestRef.current) return;
      setStudentList([]);
    } finally {
      if (requestId === rosterRequestRef.current) setStudentLoading(false);
    }
  };
  const viewStudents: ViewStudentsFn = (...args) => openRoster("holders", ...args);
  const viewTrainedNotCertified: ViewStudentsFn = (...args) => openRoster("trainedNotCertified", ...args);

  // Region and Country Set views: a row may be pooled or per-country.
  // The anchored view counts as one too: its target-country rows are.
  const multiCountryView = anchoredView || isMultiCountryScope(scopeLevel);
  /** "EMEA (theatre)" / "Set A (target countries)" — an anchored row's population, as a cell. */
  const populationCell = (req: { population?: AnchoredPopulation; populationLabel?: string }): string =>
    req.population ? `${req.populationLabel ?? ""} (${POPULATION_KIND_LABELS[req.population]})`.trim() : "";

  // Flat export: Country / Region / Country Set / Theatre, and the theatre-count
  // Global shape.
  const buildExportData = (specList: Specialisation[], levelLabel: string, filterValue: string) => {
    const rows: Record<string, string | number>[] = [];
    for (const spec of specList) {
      const emit = (req: Specialisation["requirements"][number], purpose: string) => {
        let trainingLabel = req.trainingFullTitle;
        if (req.alternatives && req.alternatives.length > 0) {
          trainingLabel += " (or " + req.alternatives.map((a) => a.trainingFullTitle).join(", ") + ")";
        }
        const row: Record<string, string | number> = {
          specialisation: spec.name,
          purpose,
          training: trainingLabel,
          type: req.trainingType ? TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType : "—",
          required: req.quantityRequired,
          attained: req.attained,
          compliant: req.attained >= req.quantityRequired ? "Yes" : "No",
        };
        if (horizonMonths > 0) {
          const projected = req.projectedAttained ?? req.attained;
          row.projectedAttained = projected;
          row.expiring = Math.max(0, req.attained - projected);
          row.projectedCompliant = projected >= req.quantityRequired ? "Yes" : "No";
        }
        row.level = levelLabel;
        row.filter = filterValue;
        // Appended after the existing columns (never reordered), and only on a
        // multi-country view, where a row can be counted either way. For an
        // "each country" row `attained` above is the lowest country's count, so
        // `compliant` already means "every country met it".
        if (multiCountryView) {
          const each = isEachCountry(req);
          row.countMode = countModeLabel(req.aggregation);
          row.countriesMet = each ? `${req.countriesMet ?? 0} / ${req.countriesTotal ?? 0}` : "";
          row.totalHolders = each ? req.pooledAttained ?? 0 : req.attained;
          if (horizonMonths > 0) {
            row.projectedCountriesMet = each
              ? `${req.projectedCountriesMet ?? req.countriesMet ?? 0} / ${req.countriesTotal ?? 0}`
              : "";
          }
        }
        // Anchored view only, and last, so every existing column keeps its position.
        if (anchoredView) row.population = populationCell(req);
        rows.push(row);
      };
      spec.requirements.forEach((req) => emit(req, "Qualification"));
      (spec.deploymentRequirements ?? []).forEach((req) => emit(req, "Deployment"));
    }
    return rows;
  };

  const exportCols = [
    { key: "specialisation", header: "Specialisation" },
    { key: "purpose", header: "Purpose" },
    { key: "training", header: "Training" },
    { key: "type", header: "Type" },
    { key: "required", header: "Required" },
    { key: "attained", header: "Attained" },
    { key: "compliant", header: "Compliant" },
    ...(horizonMonths > 0
      ? [
          { key: "projectedAttained", header: `Projected (+${horizonMonths}mo)` },
          { key: "expiring", header: "Expiring" },
          { key: "projectedCompliant", header: "Projected Compliant" },
        ]
      : []),
    { key: "level", header: "Level" },
    { key: "filter", header: "Filter" },
    ...(multiCountryView
      ? [
          { key: "countMode", header: "Count Mode" },
          { key: "countriesMet", header: "Countries Met" },
          { key: "totalHolders", header: "Total Holders" },
          ...(horizonMonths > 0
            ? [{ key: "projectedCountriesMet", header: `Projected Countries Met (+${horizonMonths}mo)` }]
            : []),
        ]
      : []),
    ...(anchoredView ? [{ key: "population", header: "Population" }] : []),
  ];

  // Global-level export with per-theatre minimums (global counts + breakdown rows).
  const buildGlobalDiamondExport = () => {
    const rows: Record<string, string | number>[] = [];
    for (const spec of specs) {
      const emit = (req: Specialisation["requirements"][number], purpose: string) => {
        let trainingLabel = req.trainingFullTitle;
        if (req.alternatives && req.alternatives.length > 0) {
          trainingLabel += " (or " + req.alternatives.map((a) => a.trainingFullTitle).join(", ") + ")";
        }
        const globalAttained = req.globalAttained ?? req.attained;
        const projectedGlobal = req.projectedGlobalAttained ?? globalAttained;
        const projCols = (count: number, projected: number, required: number): Record<string, string | number> =>
          horizonMonths > 0
            ? {
                projectedCount: projected,
                expiring: Math.max(0, count - projected),
                projectedCompliant: projected >= required ? "Yes" : "No",
              }
            : {};
        rows.push({
          specialisation: spec.name,
          purpose,
          training: trainingLabel,
          type: req.trainingType ? TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType : "—",
          required: req.quantityRequired,
          attained: globalAttained,
          compliant: req.compliant ? "Yes" : "No",
          theatre: "Global",
          theatreCount: globalAttained,
          theatreRequired: req.quantityRequired,
          theatreCompliant: req.compliant ? "Yes" : "No",
          ...projCols(globalAttained, projectedGlobal, req.quantityRequired),
        });
        if (req.theatreBreakdown) {
          for (const t of req.theatreBreakdown) {
            const tReq = req.minimumPerTheatre ?? 0;
            const tProjected = req.projectedTheatreBreakdown?.find((p) => p.theatre === t.theatre)?.count ?? t.count;
            rows.push({
              specialisation: spec.name,
              purpose,
              training: req.trainingFullTitle,
              type: req.trainingType ? TRAINING_TYPE_LABELS[req.trainingType] || req.trainingType : "—",
              required: req.quantityRequired,
              attained: globalAttained,
              compliant: req.compliant ? "Yes" : "No",
              theatre: t.theatre,
              theatreCount: t.count,
              theatreRequired: tReq,
              theatreCompliant: t.compliant ? "Yes" : "No",
              ...projCols(t.count, tProjected, tReq),
            });
          }
        }
      };
      spec.requirements.forEach((req) => emit(req, "Qualification"));
      (spec.deploymentRequirements ?? []).forEach((req) => emit(req, "Deployment"));
    }
    return rows;
  };

  const gdExportCols = [
    { key: "specialisation", header: "Specialisation" },
    { key: "purpose", header: "Purpose" },
    { key: "training", header: "Training" },
    { key: "type", header: "Type" },
    { key: "required", header: "Global Required" },
    { key: "attained", header: "Global Attained" },
    { key: "compliant", header: "Compliant" },
    { key: "theatre", header: "Theatre" },
    { key: "theatreCount", header: "Theatre Count" },
    { key: "theatreRequired", header: "Theatre Required" },
    { key: "theatreCompliant", header: "Theatre Compliant" },
    ...(horizonMonths > 0
      ? [
          { key: "projectedCount", header: `Projected (+${horizonMonths}mo)` },
          { key: "expiring", header: "Expiring" },
          { key: "projectedCompliant", header: "Projected Compliant" },
        ]
      : []),
  ];

  const sectionSlug = programName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const horizonSuffix = horizonMonths > 0 ? `-plus${horizonMonths}mo` : "";

  // Report presentation for the selected scope.
  const REPORT_META: Record<ScopeLevel, { label: string; icon: ReactNode; unit: "people" | "theatres" }> = {
    country: { label: "Country Report", icon: <MapPin size={20} className="text-blue-600" />, unit: "people" },
    region: { label: "Region Report", icon: <Map size={20} className="text-teal-600" />, unit: "people" },
    countrySet: { label: "Country Set Report", icon: <Boxes size={20} className="text-cyan-600" />, unit: "people" },
    theatre: { label: "Theatre Report", icon: <Building2 size={20} className="text-purple-600" />, unit: "people" },
    global: { label: "Global Report", icon: <Globe size={20} className="text-green-600" />, unit: "theatres" },
  };
  const ANCHORED_REPORT = {
    label: "Target Countries Report",
    icon: <Anchor size={20} className="text-cyan-600" />,
    unit: "people" as const,
  };
  const report = anchoredView ? ANCHORED_REPORT : REPORT_META[scopeLevel];
  const reportTitle = needsValue && viewValue ? `${report.label} — ${viewValue}` : report.label;

  const exportData = globalCardsView
    ? buildGlobalDiamondExport()
    : buildExportData(specs, report.label.replace(" Report", ""), needsValue ? viewValue : "Global");
  const exportColumns = globalCardsView ? gdExportCols : exportCols;
  const exportFilename = `${sectionSlug}-${viewLevel}${needsValue && viewValue ? `-${viewValue}` : ""}${horizonSuffix}`;

  /**
   * The PDF's own shape.
   *
   * CSV and Excel keep the flat `exportData`/`exportColumns` above — those are
   * data interchange, and their contents have to stay comparable with the
   * server-side scheduled exports. A PDF is read rather than pivoted, so it
   * gets what the page actually shows: a section per specialisation carrying
   * the same Met/At-risk badges and risk shading, the deployment sub-section
   * with its explanation intact, and the tier ladder.
   *
   * Assembled on demand rather than on every render. Scope, horizon and company
   * all change far more often than anyone opens the export menu.
   */
  const buildPdfDocument = (): ReportDocument => {
    const viewLevelLabel = report.label.replace(" Report", "");
    // The Global card layout counts holders worldwide and gates on a per-theatre
    // minimum; every other layout counts people inside the selected scope.
    const globalCards = globalCardsView;
    const unitLabel = globalCards ? "people" : report.unit;

    // Weighted so the training name — the only column whose content is prose —
    // gets the room it needs, and the Status column stays wide enough to hold a
    // group badge, which is drawn as a right-aligned cell in the last column.
    const baseColumns = [
      { key: "training", header: "Training", width: 5 },
      { key: "type", header: "Type", width: 2 },
      // Region / Country Set only: whether the row is pooled or per country.
      ...(multiCountryView ? [{ key: "mode", header: "Count Mode", width: 1.6 }] : []),
      // Anchored view only: where each row is counted.
      ...(anchoredView ? [{ key: "population", header: "Population", width: 2 }] : []),
      { key: "attained", header: "Attained / Required", width: 2.2, align: "center" as const },
    ];
    const statusColumn = { key: "status", header: "Status", width: 1.8, align: "center" as const };
    const columns = globalCards
      ? [
          ...baseColumns,
          { key: "minPerTheatre", header: "Min/Theatre", width: 1.3, align: "center" as const },
          statusColumn,
        ]
      : [...baseColumns, statusColumn];
    const tierColumns = [...baseColumns, statusColumn];

    const trainingCell = (
      trainingFullTitle: string,
      alternatives: AlternativeEntry[] | undefined,
      prefix?: string | null
    ): ReportRichCell => ({
      text: prefix ? `${prefix}: ${trainingFullTitle}` : trainingFullTitle,
      sub: alternativesText(alternatives),
    });

    const attainedCell = (
      attained: number,
      projected: number | undefined,
      required: number
    ): ReportRichCell => ({
      text: `${attainedText(attained, projected)} / ${required}`,
      sub: expiringText(attained, projected),
      bold: true,
      align: "center",
    });

    /**
     * The per-theatre breakdown the page hides behind an expander. A printed
     * page has no expander, so wherever the data carries one it is written out
     * as indented lines under its row.
     */
    const theatreDetail = (
      breakdown: { theatre: string; count: number; compliant: boolean }[] | null | undefined,
      projectedBreakdown: { theatre: string; count: number; compliant: boolean }[] | null | undefined,
      required: number
    ): string[] | undefined => {
      if (!breakdown || breakdown.length === 0) return undefined;
      return breakdown.map((t) => {
        const projected = projectedBreakdown?.find((p) => p.theatre === t.theatre)?.count;
        const expiring = expiringText(t.count, projected);
        const state = RISK_STATUS_LABEL[riskState(t.count, projected, required)];
        return `${t.theatre}: ${attainedText(t.count, projected)} / ${required} (${state}${expiring ? `, ${expiring}` : ""})`;
      });
    };

    /**
     * The Attained cell of an "each country" row: the countries-met figure, with
     * the lowest country (what the row is shaded by) underneath. Its per-country
     * breakdown goes into the row's detail lines, as the theatre breakdown does.
     */
    const eachCountryCell = (
      met: number,
      projectedMet: number | null | undefined,
      total: number,
      lowest: number,
      projectedLowest: number | undefined,
      required: number
    ): ReportRichCell => ({
      text: countriesMetText(met, projectedMet, total),
      sub: `Lowest country: ${attainedText(lowest, projectedLowest)} / ${required} per country`,
      bold: true,
      align: "center",
    });

    const requirementRow = (req: Requirement): ReportTonedRow => {
      if (!globalCards && isEachCountry(req)) {
        const state = riskState(req.attained, req.projectedAttained, req.quantityRequired);
        const cells: Record<string, ReportCellValue> = {
          training: trainingCell(req.trainingFullTitle, req.alternatives),
          type: trainingTypeLabel(req.trainingType),
          attained: eachCountryCell(
            req.countriesMet ?? 0,
            req.projectedCountriesMet,
            req.countriesTotal ?? 0,
            req.attained,
            req.projectedAttained,
            req.quantityRequired
          ),
          status: { text: RISK_STATUS_LABEL[state], align: "center" },
        };
        if (multiCountryView) cells.mode = countModeLabel(req.aggregation);
        if (anchoredView) cells.population = populationCell(req);
        return {
          tone: RISK_TONE[state],
          cells,
          detail: countryBreakdownLines(req.countryBreakdown, req.projectedCountryBreakdown, req.quantityRequired),
        };
      }
      const attained = globalCards ? req.globalAttained ?? req.attained : req.attained;
      const projected = globalCards ? req.projectedGlobalAttained : req.projectedAttained;
      const countState = riskState(attained, projected, req.quantityRequired);
      // On the Global cards the status also weighs the per-theatre minimum,
      // which the headline count cannot express, so it comes from the API's own
      // verdict rather than being re-derived here.
      const statusState = globalCards
        ? complianceRiskState(req.compliant, req.projectedCompliant)
        : countState;
      const cells: Record<string, ReportCellValue> = {
        training: trainingCell(req.trainingFullTitle, req.alternatives),
        type: trainingTypeLabel(req.trainingType),
        attained: attainedCell(attained, projected, req.quantityRequired),
        status: { text: RISK_STATUS_LABEL[statusState], align: "center" },
      };
      if (globalCards) cells.minPerTheatre = req.minimumPerTheatre ?? "—";
      if (multiCountryView) cells.mode = countModeLabel(req.aggregation);
      if (anchoredView) cells.population = populationCell(req);
      return {
        tone: RISK_TONE[countState],
        cells,
        detail: theatreDetail(
          req.theatreBreakdown,
          req.projectedTheatreBreakdown,
          req.minimumPerTheatre ?? 0
        ),
      };
    };

    const tierRequirementRow = (req: TierDeploymentRequirement): ReportTonedRow => {
      const projected = req.projectedAttained ?? undefined;
      const countState = riskState(req.attained, projected, req.quantityRequired);
      const statusState = complianceRiskState(req.compliant, req.projectedCompliant);
      const each = isEachCountry(req);
      const cells: Record<string, ReportCellValue> = {
        // In "perTierPerSpecialisation" mode each row belongs to one
        // specialisation, which the page prefixes to the training name.
        training: trainingCell(req.trainingFullTitle, req.alternatives, req.specialisationName),
        type: trainingTypeLabel(req.trainingType),
        attained: each
          ? eachCountryCell(
              req.countriesMet ?? 0,
              req.projectedCountriesMet,
              req.countriesTotal ?? 0,
              req.attained,
              projected,
              req.quantityRequired
            )
          : attainedCell(req.attained, projected, req.quantityRequired),
        status: { text: RISK_STATUS_LABEL[statusState], align: "center" },
      };
      if (multiCountryView) cells.mode = countModeLabel(req.aggregation);
      if (anchoredView) cells.population = populationCell(req);
      return {
        tone: RISK_TONE[countState],
        cells,
        detail: each
          ? countryBreakdownLines(req.countryBreakdown, req.projectedCountryBreakdown, req.quantityRequired)
          : theatreDetail(
              req.theatreBreakdown,
              req.projectedTheatreBreakdown,
              req.minimumPerTheatre ?? 0
            ),
      };
    };

    const sections: ReportSection[] = [];

    // The page's amber projection banner, so a printed copy explains its own
    // amber shading rather than leaving the reader to infer it.
    if (horizonMonths > 0) {
      sections.push({
        kind: "note",
        title: "Projection",
        lines: [
          `Showing compliance as it will stand in ${horizonMonths} months (current -> projected).`,
          "Rows shaded amber are compliant today but fall below their requirement as certificates expire within the window.",
        ],
        tone: "amber",
      });
    }

    // The anchored view's warnings, before anything they qualify — as on the page.
    if (anchoredView && anchoredMeta) {
      const lines: string[] = [];
      if (anchoredMeta.outOfTheatreCountries.length > 0) {
        lines.push(
          `Not counted: ${anchoredMeta.outOfTheatreCountries.join(", ")} ` +
            `${anchoredMeta.outOfTheatreCountries.length === 1 ? "is" : "are"} in the set but outside ` +
            `${anchoredMeta.anchorTheatre}, so ${anchoredMeta.outOfTheatreCountries.length === 1 ? "it counts" : "they count"} ` +
            "toward neither the minimum nor the target-country requirements."
        );
      }
      if (ignoredLevels.length > 0) {
        lines.push(
          `Requirements at ${ignoredLevels.map(levelLabel).join(", ")} level are not evaluated for an anchored program.`
        );
      }
      if (lines.length > 0) sections.push({ kind: "note", title: "Warnings", lines, tone: "amber" });
    }

    // Tier Status comes first, as it does on the page.
    if (isTiered && tierBlock) {
      const block = tierBlock;
      const achieved = block.achievedSpecialisationCount;
      const projectedAchieved = block.projectedAchievedSpecialisationCount ?? undefined;
      const projectedHighest = block.projectedHighestAchievedTier;
      const highestChanges =
        projectedHighest !== null && projectedHighest !== block.highestAchievedTier;
      const achievedList =
        block.achievedSpecialisations.length > 0
          ? block.achievedSpecialisations.join(", ")
          : "none yet";

      sections.push({
        kind: "note",
        title: "Tier Status",
        lines: [
          highestChanges
            ? `Highest tier achieved: ${block.highestAchievedTier ?? "None"} -> projected ${projectedHighest ?? "None"}`
            : `Highest tier achieved: ${block.highestAchievedTier ?? "None"}`,
          `${attainedText(achieved, projectedAchieved)} specialisation${achieved === 1 ? "" : "s"} achieved (${achievedList})`,
        ],
        tone: highestChanges ? "amber" : block.highestAchievedTier ? "green" : "muted",
      });

      if (block.minimumCountriesGate && !block.minimumCountriesGate.met) {
        sections.push({
          kind: "note",
          title: "Minimum target countries not met",
          lines: [minimumGateText(block.minimumCountriesGate, anchorTheatre)],
          tone: "red",
        });
      }

      const sortedTiers = [...block.tiers].sort((a, b) => a.sortOrder - b.sortOrder);
      // Next tier to aim for = the lowest tier not currently compliant, as on the page.
      const nextTier = sortedTiers.find((t) => !t.compliant) ?? null;
      const tierGroups: ReportRowGroup[] = sortedTiers.map((tier): ReportRowGroup => {
        const gate = tierGate(block, tier);
        const shortfall = gate.required - gate.counted;
        return {
          title: tier.name,
          badge: tier.compliant ? "Achieved" : nextTier?.name === tier.name ? "Next tier" : "Not yet",
          badgeTone: tier.compliant ? "green" : "muted",
          subtitle:
            `${gate.label}: ${gate.counted} / ${gate.required}` +
            (gate.met ? "" : ` (need ${shortfall} more)`) +
            ` · Achieved: ${achievedList}`,
          rows: tier.deploymentRequirements.map(tierRequirementRow),
          note:
            tier.deploymentRequirements.length === 0
              ? "No deployment requirements for this tier."
              : undefined,
        };
      });
      // Program-wide gates are required by every tier, so — as on the page —
      // they are one group ahead of the tiers rather than repeated in each.
      const gates = block.gateRequirements ?? [];
      if (gates.length > 0) {
        const gatesMet = gates.every((g) => g.compliant);
        // The same amber-vs-red rule as the page's badge.
        const gatesState = complianceRiskState(
          gatesMet,
          gates.some((g) => g.projectedCompliant === false) ? false : gatesMet
        );
        tierGroups.unshift({
          title: GATES_HEADING,
          badge: RISK_STATUS_LABEL[gatesState],
          badgeTone: RISK_TONE[gatesState],
          subtitle: "Every tier requires all of these, in addition to its own criteria.",
          rows: gates.map(tierRequirementRow),
        });
      }
      sections.push({
        title: "Tiers",
        columns: tierColumns,
        rows: [],
        groups: tierGroups,
        emptyText: "No tiers configured for this program yet.",
      });
    }

    for (const spec of specs) {
      const qualState = complianceRiskState(spec.compliant, spec.projectedCompliant);
      const deploymentReqs = spec.deploymentRequirements ?? [];
      const groups: ReportRowGroup[] = [
        {
          title: "Qualification requirements",
          badge: RISK_COMPLIANCE_LABEL[qualState],
          badgeTone: RISK_TONE[qualState],
          rows: spec.requirements.map(requirementRow),
          note:
            spec.requirements.length === 0
              ? "No qualifying requirements configured for this specialisation."
              : undefined,
        },
      ];
      if (deploymentReqs.length > 0) {
        const depState = complianceRiskState(
          spec.deploymentCompliant,
          spec.projectedDeploymentCompliant
        );
        groups.push({
          title: "Deployment requirements",
          badge: RISK_STATUS_LABEL[depState],
          badgeTone: RISK_TONE[depState],
          subtitle: DEPLOYMENT_REQUIREMENTS_NOTE,
          rows: deploymentReqs.map(requirementRow),
        });
      }
      sections.push({
        title: spec.name,
        // The specialisation's own verdict, coloured, so the state is legible
        // from the heading alone — the group bands inside repeat it per
        // requirement kind, which is a level of detail a skim does not want.
        badge: RISK_COMPLIANCE_LABEL[qualState],
        badgeTone: RISK_TONE[qualState],
        columns,
        rows: [],
        groups,
      });
    }

    return {
      title: "Program Compliance",
      meta: [
        { label: "Program", value: programName },
        { label: "Level", value: viewLevelLabel },
        { label: "Scope", value: needsValue ? viewValue || "—" : "Global" },
        ...(anchoredView && anchoredMeta
          ? [
              { label: "Anchor theatre", value: anchoredMeta.anchorTheatre },
              {
                label: "Target countries",
                value: anchoredMeta.targetCountries.length > 0 ? anchoredMeta.targetCountries.join(", ") : "none",
              },
              {
                label: "Minimum countries",
                value:
                  anchoredMeta.minimumCountries === null
                    ? MINIMUM_SOURCE_LABELS.none
                    : `${anchoredMeta.minimumCountries} (${MINIMUM_SOURCE_LABELS[anchoredMeta.minimumCountriesSource]})`,
              },
            ]
          : []),
        { label: "Counting", value: unitLabel === "theatres" ? "compliant theatres" : "people" },
        {
          label: "Compliance as of",
          value: horizonMonths > 0 ? `+${horizonMonths} months` : "Now",
        },
      ],
      sections,
      // One wide prose column beside four narrow numeric ones: this document is
      // long rather than wide, and portrait fits a third more rows to a page.
      // Pinned rather than left to the renderer's column-count heuristic so the
      // extra Min/Theatre column at Global level cannot silently flip it.
      orientation: "portrait",
    };
  };

  const noLevels = !companyRequired && meta !== null && meta.levels.length === 0;

  return (
    <div>
      <PageHeader
        title={programName}
        helpSlug="programs-detail"
        showBack
        rightContent={
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">Compliance as of</label>
            <select
              value={horizonMonths}
              onChange={(e) => setHorizonMonths(Number(e.target.value))}
              className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white"
              title="Project compliance forward to see the impact of upcoming certificate expiry"
            >
              <option value={0}>Now</option>
              <option value={3}>+3 months</option>
              <option value={6}>+6 months</option>
              <option value={12}>+12 months</option>
            </select>
          </div>
        }
      />

      {/*
        Ahead of the scope selector, not beside it: there is no point offering a
        level and a value for a dashboard the page has already decided not to
        draw. Everything below is suppressed while gated, and the suppression is
        needed rather than incidental — `meta`, `specs` and `tierBlock` hold
        whatever the last selected company returned, so switching the header
        back to "All companies" would otherwise leave that company's report on
        screen underneath a card saying no company is selected.
      */}
      {companyRequired && <CompanyRequired what="dashboard" />}

      {!companyRequired && !noOfferedLevels && !noTargetSets && horizonMonths > 0 && meta && meta.levels.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <span className="font-medium">Projection:</span>
          <span>
            Showing compliance as it will stand in <strong>{horizonMonths} months</strong> (current → projected).
            Items shaded <span className="font-medium text-amber-700">amber</span> are compliant today but will
            fall below their requirement as certificates expire within the window.
          </span>
        </div>
      )}

      {noLevels && (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          No compliance data configured for <strong>{programName}</strong>. Add requirements in{" "}
          <Link href="/admin/program-data" className="text-blue-600 hover:underline">Admin &rsaquo; Program Data</Link>{" "}
          using this program name.
        </div>
      )}

      {noOfferedLevels && (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          <strong>{programName}</strong> reports by Country Set, and the selected company has no Country
          Sets defined. Add one in{" "}
          <Link href="/admin/country-sets" className="text-blue-600 hover:underline">Admin &rsaquo; Country Sets</Link>.
        </div>
      )}

      {noTargetSets && (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          <strong>{programName}</strong> is reported over each partner&apos;s target countries (a Country Set)
          {anchorTheatre ? ` within ${anchorTheatre}` : ""}, and the selected company has no Country Sets
          defined. Add one in{" "}
          <Link href="/admin/country-sets" className="text-blue-600 hover:underline">Admin &rsaquo; Country Sets</Link>.
        </div>
      )}

      {!companyRequired && !noOfferedLevels && !noTargetSets && meta && meta.levels.length > 0 && (
        <>
          {/* Page-level scope selector — drives both the tier status and report. */}
          <FilterBar>
            {anchoredView ? (
              // An anchored program has one view: the partner's target countries
              // (a Country Set of theirs) within the program's anchor theatre.
              <FilterBar.Row>
                <label className="text-sm font-medium text-gray-700" htmlFor="program-target-set">
                  {ANCHORED_SCOPE_LABEL} (Country Set)
                </label>
                <select
                  id="program-target-set"
                  value={targetSet}
                  onChange={(e) => setTargetSet(e.target.value)}
                  className={`${SELECT_CLASS} min-w-[200px]`}
                >
                  <option value="">Select a Country Set…</option>
                  {countrySets.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                {anchorTheatre && <span className="text-sm text-gray-500">within {anchorTheatre}</span>}
              </FilterBar.Row>
            ) : (
            <FilterBar.Row>
              <label className="text-sm font-medium text-gray-700" htmlFor="program-level">View by</label>
              <select
                id="program-level"
                value={scopeLevel}
                onChange={(e) => changeScopeLevel(e.target.value as ScopeLevel)}
                className={SELECT_CLASS}
              >
                {offeredLevels.map((l) => (
                  <option key={l} value={l}>{SCOPE_LEVEL_LABELS[l]}</option>
                ))}
              </select>
              {needsValue && (
                <>
                  <label className="text-sm font-medium text-gray-700 capitalize" htmlFor="program-value">{valueNoun(scopeLevel)}</label>
                  <select
                    id="program-value"
                    value={scopeValue}
                    onChange={(e) => setScopeValue(e.target.value)}
                    className={`${SELECT_CLASS} min-w-[200px]`}
                  >
                    <option value="">Select a {valueNoun(scopeLevel)}…</option>
                    {scopeValues.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </>
              )}
            </FilterBar.Row>
            )}
          </FilterBar>

          {/* The anchored view's header: what it is counted over, and anything
              about that the reader must not miss. None of it is dismissible —
              each describes the numbers on this screen. */}
          {anchoredMeta && (
            <div className="mb-4 space-y-2">
              <div className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700">
                <span className="font-medium">
                  {anchoredMeta.targetCountries.length} target{" "}
                  {anchoredMeta.targetCountries.length === 1 ? "country" : "countries"}
                </span>
                {" · "}
                {anchoredMeta.minimumCountries === null
                  ? MINIMUM_SOURCE_LABELS.none
                  : `minimum ${anchoredMeta.minimumCountries} (${MINIMUM_SOURCE_LABELS[anchoredMeta.minimumCountriesSource]})`}
                {anchoredMeta.targetCountries.length > 0 && (
                  <div className="text-xs text-gray-500 mt-0.5">{anchoredMeta.targetCountries.join(", ")}</div>
                )}
              </div>
              {anchoredMeta.outOfTheatreCountries.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>
                    <strong>{anchoredMeta.outOfTheatreCountries.join(", ")}</strong>{" "}
                    {anchoredMeta.outOfTheatreCountries.length === 1 ? "is" : "are"} in this set but outside{" "}
                    {anchoredMeta.anchorTheatre}, so {anchoredMeta.outOfTheatreCountries.length === 1 ? "it counts" : "they count"}{" "}
                    toward neither the minimum nor the target-country requirements.
                  </span>
                </div>
              )}
              {ignoredLevels.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>
                    This program has requirements at {ignoredLevels.map(levelLabel).join(", ")} level, which an
                    anchored program does not evaluate (only Theatre and Country Set rows count). Move them in{" "}
                    <Link href="/admin/program-data" className="underline">Admin &rsaquo; Program Data</Link>.
                  </span>
                </div>
              )}
              {!anchoredMeta.minimumMet && anchoredMeta.minimumCountries !== null && (
                <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
                  <div className="font-semibold">Minimum target countries not met</div>
                  <div>
                    {minimumGateText(
                      {
                        required: anchoredMeta.minimumCountries,
                        counted: anchoredMeta.targetCountries.length,
                        met: false,
                        source: anchoredMeta.minimumCountriesSource,
                      },
                      anchoredMeta.anchorTheatre
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tier Status (tiered programs) */}
          {isTiered && (
            <section className="mb-6">
              <div className="flex items-center gap-2 p-4 bg-white rounded-lg border border-gray-200">
                <Layers size={20} className="text-indigo-600" />
                <span className="text-lg font-semibold">Tier Status</span>
              </div>
              <div className="mt-2 bg-white rounded-lg border border-gray-200 p-4">
                {loading ? (
                  <LoadingSpinner />
                ) : scopeMissing ? (
                  <p className="text-sm text-gray-500">Select a {promptNoun} to view tier status.</p>
                ) : !tierBlock ? (
                  <p className="text-sm text-gray-500">No tier data for this program.</p>
                ) : (
                  <TierLadder block={tierBlock} level={viewLevel} anchorTheatre={anchorTheatre} />
                )}
              </div>
            </section>
          )}

          {/* Compliance report for the selected scope */}
          <section className="mb-6">
            <div className="flex items-center justify-between gap-3 p-4 bg-white rounded-lg border border-gray-200">
              <div className="flex items-center gap-2">
                {report.icon}
                <span className="text-lg font-semibold">{reportTitle}</span>
              </div>
              {!scopeMissing && specs.length > 0 && (
                <ExportMenu
                  show={showExport}
                  setShow={setShowExport}
                  data={exportData}
                  columns={exportColumns}
                  filename={exportFilename}
                  align="right"
                  pdfDocument={buildPdfDocument}
                />
              )}
            </div>
            <div className="mt-2">
              {loading ? (
                <div className="bg-white rounded-lg border border-gray-200 p-4"><LoadingSpinner /></div>
              ) : scopeMissing ? (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <p className="text-sm text-gray-500">Select a {promptNoun} to view compliance data.</p>
                </div>
              ) : specs.length === 0 ? (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <p className="text-sm text-gray-500">
                    No {report.label.replace(" Report", "")}-level requirements found for this program.
                  </p>
                </div>
              ) : globalCardsView ? (
                specs.map((spec) => <SpecialisationCard key={spec.name} spec={spec} />)
              ) : (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <ComplianceTable
                    specialisations={specs}
                    level={viewLevel}
                    filterValue={needsValue ? viewValue : ""}
                    onViewStudents={viewStudents}
                    onViewTrainedNotCertified={viewTrainedNotCertified}
                    horizonMonths={horizonMonths}
                    unitLabel={report.unit}
                  />
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {/* Student Modal */}
      <Modal
        open={showStudents}
        onClose={() => setShowStudents(false)}
        title={studentMode === "trainedNotCertified" ? `Trained, not certified — ${studentTitle}` : "Students"}
        size="4xl"
      >
        {studentMode === "trainedNotCertified" && (
          <p className="text-sm text-gray-600 mb-4">
            People in this view holding a current instructor-led or OLX training that leads to{" "}
            <strong>{studentTitle}</strong> or one of its certification alternatives, who hold none of them
            currently (a lapsed certification counts as not held). Listed under each training they hold, with that training&apos;s dates.
            {horizonMonths > 0 && " Shown as of today, not at the projection horizon."}
          </p>
        )}
        {studentLoading ? (
          <LoadingSpinner />
        ) : studentList.length === 0 ? (
          <p className="text-sm text-gray-500">No students found.</p>
        ) : (
          <div className="max-h-[400px] overflow-y-auto space-y-6">
            {studentGroups.length > 1 && (
              <p className="text-sm text-gray-600">
                {studentList.length} {studentList.length === 1 ? "person" : "people"}
                {studentGroups.reduce((n, [, g]) => n + g.length, 0) > studentList.length &&
                  " — someone holding more than one of these trainings is listed under each"}
              </p>
            )}
            {studentGroups.map(([training, students]) => (
              <div key={training}>
                <h3 className="text-sm font-semibold text-gray-800 mb-2">
                  {training} <span className="font-normal text-gray-500">({students.length})</span>
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Full Name</th>
                        <th className="px-3 py-2 text-left font-medium">Email</th>
                        <th className="px-3 py-2 text-left font-medium">Country</th>
                        <th className="px-3 py-2 text-left font-medium">Theatre</th>
                        <th className="px-3 py-2 text-left font-medium">Completed</th>
                        <th className="px-3 py-2 text-left font-medium">Expires</th>
                        <th className="px-3 py-2 text-center font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {students.map((s) => (
                        <tr key={s.email} className="border-t border-gray-100">
                          <td className="px-3 py-2">{s.fullName}</td>
                          <td className="px-3 py-2">{s.email}</td>
                          <td className="px-3 py-2">{s.country}</td>
                          <td className="px-3 py-2">{s.theatre}</td>
                          <td className="px-3 py-2">{s.completedDate}</td>
                          <td className={`px-3 py-2 ${isExpiringSoon(s.expiryDate) ? "text-red-600 font-medium" : ""}`}>
                            {s.expiryDate}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <a
                              href={`/students/${encodeURIComponent(s.email)}`}
                              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                            >
                              <ExternalLink size={12} /> View
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function ProgramDetailPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <ProgramDetailPageInner />
    </Suspense>
  );
}
