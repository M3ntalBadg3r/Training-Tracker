"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  ExternalLink,
} from "lucide-react";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import {
  ComplianceTable,
  SpecialisationCard,
  ExportMenu,
  LoadingSpinner,
  TierLadder,
  TRAINING_TYPE_LABELS,
  DEPLOYMENT_REQUIREMENTS_NOTE,
  RISK_COMPLIANCE_LABEL,
  RISK_STATUS_LABEL,
  RISK_TONE,
  alternativesText,
  attainedText,
  complianceRiskState,
  expiringText,
  riskState,
  tierGate,
  trainingTypeLabel,
  type AlternativeEntry,
  type Requirement,
  type Specialisation,
  type StudentEntry,
  type TierBlock,
  type TierDeploymentRequirement,
} from "@/components/programs/ProgramCompliance";
import type {
  ReportCellValue,
  ReportDocument,
  ReportRichCell,
  ReportRowGroup,
  ReportSection,
  ReportTonedRow,
} from "@/lib/report-export";

interface ProgramMeta {
  levels: string[];
  hasMinimumPerTheatre: boolean;
  isTiered?: boolean;
  deploymentMode?: string;
}

type ScopeLevel = "global" | "theatre" | "region" | "country";

// ── URL round-trip for the view ──
// Scope and horizon are mirrored to the query string so Back from a student
// record restores the view (see the mirror effect below). Values read back are
// validated rather than trusted: the horizon must be one the selector can
// render, and a seeded scope is additionally checked against the program's own
// configured levels before it is accepted.

/** The "Compliance as of" options — a value outside this set has no option to render. */
const HORIZON_OPTIONS = [0, 3, 6, 12];

function parseScopeLevel(v: string | null): ScopeLevel | null {
  return v === "global" || v === "theatre" || v === "region" || v === "country" ? v : null;
}

function parseHorizon(v: string | null): number {
  const n = parseInt(v ?? "", 10);
  return HORIZON_OPTIONS.includes(n) ? n : 0;
}

/**
 * Whether the program offers a level. Region is not a configured level of its
 * own — it is derived from Country-level requirements, so it rides on Country.
 */
function levelOffered(level: ScopeLevel, levels: string[]): boolean {
  if (level === "global") return levels.includes("Global");
  if (level === "theatre") return levels.includes("Theatre");
  return levels.includes("Country");
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
  // Compliance is per-company; force a single-company selection.
  // Reconciled with React's "adjust state while rendering" pattern rather than a
  // setState-in-effect. The "all companies" branch is deliberately sticky — it
  // seeds the first company but must never clobber a later explicit pick.
  const [companyId, setCompanyId] = useState<number | null>(null);
  const companyKey = companyScope.loading
    ? null
    : `${companyScope.selected}|${companyScope.companies.map((c) => c.id).join(",")}`;
  const [prevCompanyKey, setPrevCompanyKey] = useState<string | null>(null);
  if (companyKey !== null && companyKey !== prevCompanyKey) {
    setPrevCompanyKey(companyKey);
    if (companyScope.selected !== "all") {
      setCompanyId(companyScope.selected);
    } else if (companyScope.companies.length > 0) {
      setCompanyId((prev) => prev ?? companyScope.companies[0].id);
    }
  }
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
    level: parseScopeLevel(searchParams.get("level")),
    value: searchParams.get("scope") ?? "",
  }));

  const [meta, setMeta] = useState<ProgramMeta | null>(null);
  const [countries, setCountries] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [theatres, setTheatres] = useState<string[]>([]);

  // Single page-level scope: a level plus (for non-global levels) a value. This
  // one selection drives BOTH the Tier Status block and the matching report,
  // which the API returns together in a single response per level.
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>(urlScope.level ?? "global");
  const [scopeValue, setScopeValue] = useState(urlScope.value);
  const [scopeInitialised, setScopeInitialised] = useState(false);


  // Student modal
  const [showStudents, setShowStudents] = useState(false);
  const [studentList, setStudentList] = useState<StudentEntry[]>([]);
  const [studentLoading, setStudentLoading] = useState(false);
  const [studentTitle, setStudentTitle] = useState("");

  // Group the roster by the specific training each person holds, so the modal
  // shows one table per training (primary + each alternative/variant) rather
  // than a single table implying everyone holds the requirement's primary.
  const studentGroups = useMemo(() => {
    // NB: `Map` is shadowed by the lucide-react icon import, so use a plain object.
    const groups: Record<string, StudentEntry[]> = {};
    for (const s of studentList) {
      const key = s.training ?? "—";
      (groups[key] ??= []).push(s);
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

  const hasCountry = meta?.levels.includes("Country") ?? false;
  const hasTheatre = meta?.levels.includes("Theatre") ?? false;
  const hasGlobal = meta?.levels.includes("Global") ?? false;
  const gdStyleGlobal = meta?.hasMinimumPerTheatre ?? false;
  const isTiered = meta?.isTiered ?? false;

  const needsValue = scopeLevel !== "global";
  const valuesForLevel = (l: ScopeLevel) => (l === "theatre" ? theatres : l === "region" ? regions : countries);
  const scopeValues = valuesForLevel(scopeLevel);
  const scopeMissing = needsValue && !scopeValue;

  // Initial load — fetch metadata + available countries/regions/theatres.
  useEffect(() => {
    if (companyId === null) return;
    fetch(`${apiBase}?level=country${companyQS}`)
      .then((r) => r.json())
      .then((data) => {
        setCountries(data.countries || []);
        setRegions(data.regions || []);
        setTheatres(data.theatres || []);
        setMeta(data.meta || { levels: [], hasMinimumPerTheatre: false });
      })
      .catch(() => {});
  }, [companyId, companyQS, apiBase]);

  // Default the scope once we know which levels exist: pick the broadest
  // configured level, and auto-select the first value for value-requiring
  // levels. Done while rendering (the `scopeInitialised` latch makes it
  // one-shot) rather than in an effect, since the user owns the scope after.
  // A scope seeded from the URL (back-navigation, a shared link) wins over that
  // default — but only once it has been checked against this program, which is
  // what `meta` arriving makes possible. A stale link naming a level the
  // program no longer configures, or a value no longer in its list, falls back
  // to the default rather than parking the page on a scope with no data.
  if (meta && !scopeInitialised && meta.levels.length > 0) {
    const seedUsable =
      urlScope.level !== null &&
      levelOffered(urlScope.level, meta.levels) &&
      (urlScope.level === "global" || valuesForLevel(urlScope.level).includes(urlScope.value));
    if (!seedUsable) {
      if (meta.levels.includes("Global")) {
        setScopeLevel("global");
        setScopeValue("");
      } else if (meta.levels.includes("Theatre")) {
        setScopeLevel("theatre");
        setScopeValue(theatres[0] ?? "");
      } else if (meta.levels.includes("Country")) {
        setScopeLevel("country");
        setScopeValue(countries[0] ?? "");
      }
    }
    setScopeInitialised(true);
  }

  const changeScopeLevel = (level: ScopeLevel) => {
    setScopeLevel(level);
    if (level === "global") setScopeValue("");
    else if (level === "theatre") setScopeValue(theatres[0] ?? "");
    else if (level === "region") setScopeValue(regions[0] ?? "");
    else setScopeValue(countries[0] ?? "");
  };

  // Mirror the view to the URL so Back from a student record restores it.
  // Gated on `scopeInitialised` because until the default pass has run the
  // scope is provisional — writing it would mirror "global" over a seeded
  // level and defeat the very restore this exists for.
  const buildViewParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("level", scopeLevel);
    if (scopeLevel !== "global" && scopeValue) params.set("scope", scopeValue);
    if (horizonMonths > 0) params.set("horizon", String(horizonMonths));
    return params;
  }, [scopeLevel, scopeValue, horizonMonths]);

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
    if (companyId === null || !scopeInitialised || scopeMissing) return null;
    const qs = new URLSearchParams({ level: scopeLevel });
    if (scopeLevel === "country") qs.set("country", scopeValue);
    else if (scopeLevel === "region") qs.set("region", scopeValue);
    else if (scopeLevel === "theatre") qs.set("theatre", scopeValue);
    return `${apiBase}?${qs.toString()}${companyQS}${horizonQS}`;
  })();
  const { data: reportData, loading: reportLoading } = useFetchJson<{
    specialisations?: Specialisation[];
    tiers?: TierBlock | null;
  }>(reportUrl);
  const loading = !scopeMissing && reportLoading;
  const specs = useMemo(
    () => (scopeMissing ? [] : reportData?.specialisations ?? []),
    [scopeMissing, reportData]
  );
  const tierBlock = scopeMissing ? null : reportData?.tiers ?? null;

  const viewStudents = async (
    trainingTitle: string,
    trainingFullTitle: string,
    level: string,
    filterValue: string,
    alternatives?: AlternativeEntry[]
  ) => {
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
    if (level === "country") params.set("country", filterValue);
    if (level === "region") params.set("region", filterValue);
    if (level === "theatre") params.set("theatre", filterValue);
    if (companyId !== null) params.set("companyId", String(companyId));

    try {
      const res = await fetch(`${apiBase}?${params}`);
      const data = await res.json();
      setStudentList(data.students || []);
    } catch {
      setStudentList([]);
    } finally {
      setStudentLoading(false);
    }
  };

  // Flat export: Country / Region / Theatre, and the theatre-count Global shape.
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
    theatre: { label: "Theatre Report", icon: <Building2 size={20} className="text-purple-600" />, unit: "people" },
    global: { label: "Global Report", icon: <Globe size={20} className="text-green-600" />, unit: "theatres" },
  };
  const report = REPORT_META[scopeLevel];
  const reportTitle = needsValue && scopeValue ? `${report.label} — ${scopeValue}` : report.label;

  const exportData = gdStyleGlobal && scopeLevel === "global"
    ? buildGlobalDiamondExport()
    : buildExportData(specs, report.label.replace(" Report", ""), needsValue ? scopeValue : "Global");
  const exportColumns = gdStyleGlobal && scopeLevel === "global" ? gdExportCols : exportCols;
  const exportFilename = `${sectionSlug}-${scopeLevel}${needsValue && scopeValue ? `-${scopeValue}` : ""}${horizonSuffix}`;

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
    const levelLabel = report.label.replace(" Report", "");
    // The Global card layout counts holders worldwide and gates on a per-theatre
    // minimum; every other layout counts people inside the selected scope.
    const globalCards = gdStyleGlobal && scopeLevel === "global";
    const unitLabel = globalCards ? "people" : report.unit;

    // Weighted so the training name — the only column whose content is prose —
    // gets the room it needs, and the Status column stays wide enough to hold a
    // group badge, which is drawn as a right-aligned cell in the last column.
    const baseColumns = [
      { key: "training", header: "Training", width: 5 },
      { key: "type", header: "Type", width: 2 },
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

    const requirementRow = (req: Requirement): ReportTonedRow => {
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
      return {
        tone: RISK_TONE[countState],
        cells: {
          // In "perTierPerSpecialisation" mode each row belongs to one
          // specialisation, which the page prefixes to the training name.
          training: trainingCell(req.trainingFullTitle, req.alternatives, req.specialisationName),
          type: trainingTypeLabel(req.trainingType),
          attained: attainedCell(req.attained, projected, req.quantityRequired),
          status: { text: RISK_STATUS_LABEL[statusState], align: "center" },
        },
        detail: theatreDetail(
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
        { label: "Level", value: levelLabel },
        { label: "Scope", value: needsValue ? scopeValue || "—" : "Global" },
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

  const noLevels = meta !== null && meta.levels.length === 0;

  return (
    <div>
      <PageHeader
        title={programName}
        helpSlug="programs-detail"
        showBack
        rightContent={
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-500">Company</label>
            <select
              value={companyId ?? ""}
              onChange={(e) => setCompanyId(e.target.value ? Number(e.target.value) : null)}
              className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white"
            >
              {companyScope.companies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <label className="text-sm text-gray-500 ml-2">Compliance as of</label>
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

      {horizonMonths > 0 && meta && meta.levels.length > 0 && (
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

      {meta && meta.levels.length > 0 && (
        <>
          {/* Page-level scope selector — drives both the tier status and report. */}
          <FilterBar>
            <FilterBar.Row>
              <label className="text-sm font-medium text-gray-700" htmlFor="program-level">View by</label>
              <select
                id="program-level"
                value={scopeLevel}
                onChange={(e) => changeScopeLevel(e.target.value as ScopeLevel)}
                className={SELECT_CLASS}
              >
                {hasGlobal && <option value="global">Global</option>}
                {hasTheatre && <option value="theatre">By Theatre</option>}
                {hasCountry && <option value="region">By Region</option>}
                {hasCountry && <option value="country">By Country</option>}
              </select>
              {needsValue && (
                <>
                  <label className="text-sm font-medium text-gray-700 capitalize" htmlFor="program-value">{scopeLevel}</label>
                  <select
                    id="program-value"
                    value={scopeValue}
                    onChange={(e) => setScopeValue(e.target.value)}
                    className={`${SELECT_CLASS} min-w-[200px]`}
                  >
                    <option value="">Select a {scopeLevel}…</option>
                    {scopeValues.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </>
              )}
            </FilterBar.Row>
          </FilterBar>

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
                  <p className="text-sm text-gray-500">Select a {scopeLevel} to view tier status.</p>
                ) : !tierBlock ? (
                  <p className="text-sm text-gray-500">No tier data for this program.</p>
                ) : (
                  <TierLadder block={tierBlock} />
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
                  <p className="text-sm text-gray-500">Select a {scopeLevel} to view compliance data.</p>
                </div>
              ) : specs.length === 0 ? (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <p className="text-sm text-gray-500">No {scopeLevel}-level requirements found for this program.</p>
                </div>
              ) : scopeLevel === "global" && gdStyleGlobal ? (
                specs.map((spec) => <SpecialisationCard key={spec.name} spec={spec} />)
              ) : (
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <ComplianceTable
                    specialisations={specs}
                    level={scopeLevel}
                    filterValue={needsValue ? scopeValue : ""}
                    onViewStudents={viewStudents}
                    unitLabel={report.unit}
                  />
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {/* Student Modal */}
      <Modal open={showStudents} onClose={() => setShowStudents(false)} title="Students" size="4xl">
        {studentLoading ? (
          <LoadingSpinner />
        ) : studentList.length === 0 ? (
          <p className="text-sm text-gray-500">No students found.</p>
        ) : (
          <div className="max-h-[400px] overflow-y-auto space-y-6">
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
