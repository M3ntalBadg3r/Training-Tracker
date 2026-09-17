"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import FilterBar from "@/components/ui/FilterBar";
import { SELECT_CLASS } from "@/components/ui/FormControls";
import LoadingState from "@/components/ui/LoadingState";
import Modal from "@/components/ui/Modal";
import ExportMenu, { type ExportFormat } from "@/components/ui/ExportMenu";
import GeoMap from "@/components/geo/GeoMap";
import { ExportableChart, useChartCapture } from "@/components/reports/ChartCaptureProvider";
import { useCompanyScope } from "@/components/company/CompanyScopeProvider";
import { safeExternalUrl, trainingTypeLabel } from "@/lib/utils";
import { useChartTheme } from "@/lib/chart-theme";
import { exportToCsv, exportToExcel } from "@/lib/export";
import { exportReportTablePdf } from "@/lib/report-export";
import { useFetchJson } from "@/hooks/useFetchJson";
import { useRegionData } from "@/hooks/useRegionData";
import { buildOfferingBandMap, buildOfferingDensityMap } from "./band-map";
import { ExternalLink, Users, Ship, Anchor, Globe } from "lucide-react";

interface AltOut {
  trainingType: string;
  trainingTitle: string;
  trainingFullTitle: string;
}
interface ReqOut {
  id: number;
  trainingType: string | null;
  trainingTitle: string | null;
  trainingFullTitle: string;
  quantityRequired: number;
  alternatives: AltOut[];
  onshore: number | null;
  nearshore: number | null;
  offshore: number | null;
  met: boolean | null;
  /**
   * Distinct holders of this requirement per country — a decomposition of the
   * three band counts above, not a per-country verdict. Countries with no
   * holders are OMITTED, so `undefined` here is "counted, nobody holds it" for
   * a country in scope and "never counted" for one outside it; `band-map.ts`
   * resolves which. Null until a scope is selected.
   */
  holdersByCountry: Record<string, number> | null;
}
interface SpecOut {
  name: string;
  requirements: ReqOut[];
  met: boolean | null;
}
interface GeoOut {
  level: string;
  value: string;
  theatres: string[];
  onshoreCountries: string[];
  nearshoreCountries: string[];
  offshoreCountries: string[];
  hasNearshore: boolean;
  hasOffshore: boolean;
  scopeLabel: string;
}
interface OfferingResponse {
  name: string;
  description: string | null;
  link: string | null;
  countries: string[];
  regions: string[];
  specialisations: SpecOut[];
  geo: GeoOut | null;
}
interface StudentRow {
  fullName: string;
  email: string;
  country: string;
  theatre: string;
  completedDate: string;
  expiryDate: string;
  training: string;
}

/** The map card's two views. `bands` is the default. */
type MapView = "bands" | "density";

/**
 * A requirement id read back out of the query string, which is user-editable
 * text. Anything that is not a positive integer is discarded here; whether the
 * integer names a requirement this offering still has is a separate question,
 * answered against the response (see `activeReqId`).
 */
function parseRequirementId(raw: string | null): number | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function OfferingDashboardInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const offeringName = decodeURIComponent(String(params.offeringName));
  const scope = useCompanyScope();

  // Offerings are company-scoped: the URL identifies which company owns the
  // offering. Prefer it (a link from the "all" view carries it); otherwise use
  // the header switcher, falling back to the first accessible company.
  const urlCompanyId = searchParams.get("companyId");
  const companyId = useMemo(() => {
    if (urlCompanyId) return Number(urlCompanyId);
    if (scope.selected !== "all") return scope.selected;
    return scope.companies[0]?.id ?? null;
  }, [urlCompanyId, scope.selected, scope.companies]);
  const companyQS = companyId != null ? `&companyId=${companyId}` : "";

  // Scope, seeded from the URL so Back from a student record restores the view
  // (mirrored back by the effect below).
  const [level, setLevel] = useState<"country" | "region">(() =>
    searchParams.get("level") === "region" ? "region" : "country"
  );
  const [value, setValue] = useState(() => searchParams.get("value") ?? "");
  // Which map the card is showing, and — for the density map — which
  // requirement it is drawing. Both are view state and both ride in the URL.
  // Anything but the one other option falls back to the default, so the
  // `<select>` can never be handed a value it has no option for.
  const [mapView, setMapView] = useState<MapView>(() =>
    searchParams.get("mapView") === "density" ? "density" : "bands"
  );
  // Held raw; validated against the requirements this offering actually has
  // once the response arrives (see `activeReqId`). A seeded id naming a deleted
  // requirement, or one belonging to a different offering, is the realistic
  // case and must fall back rather than draw an empty map.
  const [mapReqId, setMapReqId] = useState<number | null>(() =>
    parseRequirementId(searchParams.get("mapReq"))
  );
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(false);

  const theme = useChartTheme();
  const { capturePageVisuals } = useChartCapture();
  // The country -> ISO join for the map. Shared, session-cached and global
  // reference data, so this is one fetch for the whole session.
  const { rows: regionRows, loading: regionLoading } = useRegionData();

  const router = useRouter();
  const pathname = usePathname();

  const apiBase = `/api/offerings/${encodeURIComponent(offeringName)}`;

  // `loading` is derived by useFetchJson (loadedKey !== requestKey), so it still
  // re-appears on every scope change without a synchronous setState in an
  // effect. This also adds the out-of-order-response guard the old effect
  // lacked.
  const dataUrl = (() => {
    if (scope.loading) return null;
    const qs = new URLSearchParams({ level });
    if (value) qs.set(level, value);
    return `${apiBase}?${qs.toString()}${companyQS}`;
  })();
  const { data, loading } = useFetchJson<OfferingResponse>(dataUrl);

  /**
   * Every requirement in the offering, flattened, as the density map's picker
   * options. Requirement ids are `OfferingData` rows and are independent of the
   * geography, so changing the scope never invalidates a selection — only
   * editing the offering does.
   */
  const reqOptions = useMemo(
    () =>
      (data?.specialisations ?? []).flatMap((spec) =>
        spec.requirements.map((r) => ({
          id: r.id,
          label: `${spec.name} — ${r.trainingFullTitle}`,
          req: r,
        }))
      ),
    [data]
  );

  /**
   * The requirement actually drawn — the URL's, if it names one this offering
   * still has, else the first.
   *
   * Derived rather than reconciled in an effect: an effect writing state here
   * would need a mount guard to avoid clobbering the seed, and would trip
   * `react-hooks/set-state-in-effect` besides. While the options are empty (the
   * response has not landed) the seed is returned unchanged, which is what lets
   * the URL mirror run on mount without erasing it.
   */
  const activeReqId = useMemo(() => {
    if (reqOptions.length === 0) return mapReqId;
    if (mapReqId !== null && reqOptions.some((o) => o.id === mapReqId)) return mapReqId;
    return reqOptions[0].id;
  }, [reqOptions, mapReqId]);
  const activeReq = reqOptions.find((o) => o.id === activeReqId) ?? null;

  // `companyId` is preserved exactly as it arrived rather than written from the
  // derived value: it identifies which company's offering this is, and pinning
  // a derived one into the URL would stop the page following the header
  // switcher on every later visit.
  const buildViewParams = useCallback(() => {
    const params = new URLSearchParams();
    if (urlCompanyId) params.set("companyId", urlCompanyId);
    params.set("level", level);
    if (value) params.set("value", value);
    params.set("mapView", mapView);
    // The *effective* id, not the raw seed: before the response arrives this is
    // the seed itself (so the mount mirror cannot wipe it), and afterwards it is
    // the validated one (so a stale id is corrected in the address bar rather
    // than left to mislead the next reload).
    if (activeReqId !== null) params.set("mapReq", String(activeReqId));
    return params;
  }, [urlCompanyId, level, value, mapView, activeReqId]);

  useEffect(() => {
    const qs = buildViewParams().toString();
    if (qs !== searchParams.toString()) {
      router.replace(`${pathname}?${qs}`, { scroll: false });
    }
  }, [buildViewParams, pathname, router, searchParams]);

  // Students modal
  const [students, setStudents] = useState<StudentRow[] | null>(null);
  const [studentsTitle, setStudentsTitle] = useState("");
  const [studentsLoading, setStudentsLoading] = useState(false);

  // Reset the selected value when switching level dimension.
  const changeLevel = (l: "country" | "region") => {
    setLevel(l);
    setValue("");
  };

  const sideLabel: Record<"onshore" | "nearshore" | "offshore", string> = {
    onshore: "Onshore",
    nearshore: "Nearshore",
    offshore: "Offshore",
  };

  const viewStudents = async (req: ReqOut, side: "onshore" | "nearshore" | "offshore") => {
    if (!value) return;
    const titles = [req.trainingTitle, ...req.alternatives.map((a) => a.trainingTitle)].filter(Boolean).join(",");
    setStudentsTitle(`${req.trainingFullTitle} — ${sideLabel[side]}`);
    setStudents(null);
    setStudentsLoading(true);
    try {
      const qs = new URLSearchParams({ students: "true", scope: side, level, trainingTitle: titles });
      qs.set(level, value);
      const res = await fetch(`${apiBase}?${qs.toString()}${companyQS}`);
      if (res.ok) setStudents((await res.json()).students || []);
      else setStudents([]);
    } finally {
      setStudentsLoading(false);
    }
  };

  const scopeValues = level === "country" ? data?.countries ?? [] : data?.regions ?? [];
  const hasScope = value !== "";

  // Export rows (only meaningful once a scope is picked).
  const exportColumns = [
    { key: "specialisation", header: "Specialisation" },
    { key: "trainingType", header: "Type" },
    { key: "training", header: "Training" },
    { key: "minRequired", header: "Min Required" },
    { key: "onshore", header: "Onshore" },
    { key: "nearshore", header: "Nearshore" },
    { key: "offshore", header: "Offshore" },
    { key: "met", header: "Met" },
  ];
  const exportData: Record<string, string | number>[] = (data?.specialisations ?? []).flatMap((s) =>
    s.requirements.map((r) => ({
      specialisation: s.name,
      trainingType: r.trainingType ? trainingTypeLabel(r.trainingType) : "",
      training: r.trainingFullTitle,
      minRequired: r.quantityRequired,
      onshore: r.onshore ?? 0,
      nearshore: r.nearshore ?? "—",
      offshore: r.offshore ?? "—",
      met: r.met === null ? "" : r.met ? "Yes" : "No",
    }))
  );
  const exportFilename = `offering-${offeringName}-${level}${value ? `-${value}` : ""}`.replace(/\s+/g, "-");

  const geo = data?.geo ?? null;

  // Geometry only — no colour. A theme-dependent value living in here would
  // change this array's identity when `ForceLightChartsContext` flips for a PDF
  // capture, which is the documented way to get a half-drawn chart photographed.
  // The band fills are resolved below, at render.
  const bandMap = useMemo(
    () => (geo ? buildOfferingBandMap(geo, regionRows) : null),
    [geo, regionRows]
  );

  /**
   * The density map: one requirement's holders per country.
   *
   * Per requirement, not per offering, so every shade reconciles against a row
   * the user can read — sum it over `geo.onshoreCountries` and you get that
   * row's Onshore figure, and likewise over the nearshore and offshore lists
   * (each over its own list only: Offshore is a superset of Nearshore, so a sum
   * over the whole map is not any of the three).
   */
  const densityMap = useMemo(
    () =>
      geo && activeReq
        ? buildOfferingDensityMap(geo, regionRows, activeReq.req.holdersByCountry ?? {})
        : null,
    [geo, regionRows, activeReq]
  );

  // The density view only draws when it has a requirement to draw. With none
  // configured the card says so rather than rendering an empty scale (an
  // all-grey world with a legend claiming to count holders is a picture that
  // looks like an answer).
  const showDensity = mapView === "density" && densityMap !== null;

  // Three mutually exclusive fills for a pair of bands that genuinely overlap:
  // Offshore is Nearshore plus everywhere else, so each label names the part of
  // Offshore it is. The legend is the only place that statement reaches a PDF,
  // which is why it lives in the labels rather than only in the note below.
  //
  // Cool hues from the shared categorical palette, deliberately not the
  // green/amber/red status colours: a country's shade here is a distance, never
  // a verdict (see the note under the map).
  const mapBands = [
    { key: "onshore", label: "Onshore", color: theme.series(0) },
    { key: "nearshore", label: "Nearshore = Offshore in theatre", color: theme.series(5) },
    { key: "rest", label: "Rest of world = Offshore elsewhere", color: theme.series(3) },
  ];

  const handleExport = async (fmt: ExportFormat, { includeCharts }: { includeCharts: boolean }) => {
    setExporting(true);
    try {
      if (fmt === "csv") exportToCsv(exportData, exportColumns, exportFilename);
      else if (fmt === "excel") exportToExcel(exportData, exportColumns, exportFilename);
      else {
        // Always through `exportReportTablePdf`, tickbox or not: falling back to
        // `export.ts:exportToPdf` when it is unticked would restyle the title and
        // flip the orientation threshold off a checkbox.
        exportReportTablePdf({
          title: `${data?.name ?? offeringName} — ${geo?.scopeLabel ?? value}`,
          filename: exportFilename,
          columns: exportColumns,
          rows: exportData,
          meta: [
            { label: "Offering", value: data?.name ?? offeringName },
            { label: "Scope", value: geo?.scopeLabel ?? value },
          ],
          // Charts and the KPI strip travel together: one tickbox governs both.
          ...(includeCharts ? await capturePageVisuals() : {}),
        });
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={data?.name ?? offeringName}
        showBack
        helpSlug="offerings"
        rightContent={hasScope && exportData.length > 0 ? (
          <ExportMenu show={showExport} setShow={setShowExport} onExport={handleExport} busy={exporting} align="right" />
        ) : undefined}
      />

      {/* Offering details */}
      {data && (
        <div className="mb-4 border border-gray-200 rounded-lg p-4 bg-white">
          {data.description ? <p className="text-sm text-gray-700">{data.description}</p> : <p className="text-sm text-gray-400 italic">No description</p>}
          {safeExternalUrl(data.link) && (
            <a href={safeExternalUrl(data.link) ?? undefined} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800">
              <ExternalLink size={14} /> {data.link}
            </a>
          )}
        </div>
      )}

      {/* Scope selector */}
      <FilterBar>
        <FilterBar.Row>
          <label className="text-sm font-medium text-gray-700" htmlFor="offering-level">View by</label>
          <select id="offering-level" value={level} onChange={(e) => changeLevel(e.target.value as "country" | "region")} className={SELECT_CLASS}>
            <option value="country">Country</option>
            <option value="region">Region</option>
          </select>
          <label className="text-sm font-medium text-gray-700" htmlFor="offering-value">{level === "country" ? "Country" : "Region"}</label>
          <select id="offering-value" value={value} onChange={(e) => setValue(e.target.value)} className={`${SELECT_CLASS} min-w-[200px]`}>
            <option value="">Select a {level}…</option>
            {scopeValues.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </FilterBar.Row>
        {hasScope && data?.geo && (
          <p className="text-xs text-gray-500">
            Onshore: {data.geo.onshoreCountries.length} country(ies) &middot; Nearshore: {data.geo.hasNearshore ? `${data.geo.nearshoreCountries.length} country(ies) in ${data.geo.theatres.join(", ")}` : "theatre unknown"} &middot; Offshore: {data.geo.offshoreCountries.length} country(ies) worldwide
          </p>
        )}
      </FilterBar>

      {loading ? (
        <LoadingState label="Loading offering…" />
      ) : !hasScope ? (
        <div className="bg-white rounded-lg border border-dashed border-gray-200 p-10 text-center text-gray-500">
          Select a country or region to view Onshore, Nearshore &amp; Offshore capability.
        </div>
      ) : (
        <div className="space-y-5">
          {/*
            The band map.

            Nothing inside this card may render an `<svg>` above the map:
            `chart-capture.ts:findSurface` takes the FIRST `<svg>` in the card,
            so a lucide icon in the heading would be rasterised into the PDF in
            the map's place. The heading and both notes are therefore text only,
            and the icons this page uses elsewhere stay in the tables below.
          */}
          {geo && bandMap && (
            <ExportableChart className="border border-gray-200 rounded-lg bg-white p-4">
              <h3 className="font-semibold text-gray-900">
                {showDensity && activeReq
                  ? `Where the people are: ${activeReq.req.trainingFullTitle} — ${geo.scopeLabel}`
                  : `Delivery geography — ${geo.scopeLabel}`}
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                {showDensity
                  ? "How many people hold this one training, country by country — not per-country compliance."
                  : "Where this offering can be delivered from — not per-country compliance."}{" "}
                A requirement is met by the onshore countries collectively, so holders spread across
                several countries can satisfy one that no single country meets on its own. Met and
                Not met stay on the tables below.
              </p>
              <p className="mt-1 text-sm text-gray-600">
                {showDensity
                  ? "A country that was counted and has nobody holding the training is drawn at the palest shade; a country outside this offering's geography has no figure at all and is left grey."
                  : "Offshore has no shade of its own because it overlaps the others: Offshore is Nearshore plus the rest of the world, so those two bands together are the Offshore set."}
              </p>
              {/*
                Says how many holders the shades leave out. Without it the map
                quietly totals less than the table and nothing explains the
                difference — and the help text tells people to add the countries
                up, so the mismatch is one a user is actively invited to find.
                GeoMap's own notice names the countries but cannot know values.
              */}
              {showDensity && densityMap && densityMap.omittedHolders > 0 && (
                <p className="mt-1 text-sm text-amber-700">
                  {densityMap.omittedHolders}{" "}
                  {densityMap.omittedHolders === 1 ? "holder is" : "holders are"} not shown on the
                  map, in the {densityMap.unmapped.length === 1 ? "country" : "countries"} listed
                  below with no ISO code. The shaded countries therefore total less than the figure
                  in the table. Set the code under Admin &gt; Region Data to bring{" "}
                  {densityMap.unmapped.length === 1 ? "it" : "them"} onto the map.
                </p>
              )}
              {/*
                Text and `<select>` only. An icon button here would put an
                `<svg>` above the map inside this card, and
                `chart-capture.ts:findSurface` takes the FIRST one — the PDF
                would carry the icon instead of the map.
              */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <label className="text-sm font-medium text-gray-700" htmlFor="offering-map-view">
                  Show
                </label>
                <select
                  id="offering-map-view"
                  value={mapView}
                  onChange={(e) => setMapView(e.target.value === "density" ? "density" : "bands")}
                  className={SELECT_CLASS}
                >
                  <option value="bands">Delivery geography</option>
                  <option value="density">Where the people are</option>
                </select>
                {mapView === "density" && reqOptions.length > 0 && (
                  <>
                    <label
                      className="text-sm font-medium text-gray-700"
                      htmlFor="offering-map-req"
                    >
                      Requirement
                    </label>
                    <select
                      id="offering-map-req"
                      value={activeReqId ?? ""}
                      onChange={(e) => setMapReqId(parseRequirementId(e.target.value))}
                      className={`${SELECT_CLASS} min-w-[240px] max-w-full`}
                    >
                      {reqOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              {regionLoading ? (
                <div className="flex h-60 items-center justify-center text-sm text-gray-500">
                  Loading country codes…
                </div>
              ) : mapView === "density" && !densityMap ? (
                <div className="flex h-60 items-center justify-center text-sm text-gray-500">
                  This offering has no supporting trainings to count yet.
                </div>
              ) : showDensity && densityMap ? (
                /*
                  Sequential, single hue. A red/green scale would read as a
                  per-country pass/fail, which is exactly what this map is not
                  (see the note above): `met` is decided on the onshore set as a
                  whole.
                */
                <GeoMap
                  data={densityMap.data}
                  mode="sequential"
                  valueLabel="Active holders"
                  unmapped={densityMap.unmapped}
                />
              ) : (
                <GeoMap
                  data={bandMap.data}
                  mode="categorical"
                  bands={mapBands}
                  unmapped={bandMap.unmapped}
                />
              )}
            </ExportableChart>
          )}

          {(data?.specialisations.length ?? 0) === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
              This offering has no specialisations configured yet.
            </div>
          ) : (
            data!.specialisations.map((spec) => (
            <div key={spec.name} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                <h3 className="font-semibold text-gray-900">{spec.name}</h3>
                {spec.met !== null && (
                  <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${spec.met ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {spec.met ? "Met" : "Not met"}
                  </span>
                )}
              </div>
              {spec.requirements.length === 0 ? (
                <p className="px-4 py-4 text-sm text-gray-400 italic">No supporting trainings defined.</p>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium">Training</th>
                      <th className="px-4 py-2 font-medium"><span className="inline-flex items-center gap-1"><Anchor size={12} /> Onshore</span></th>
                      <th className="px-4 py-2 font-medium"><span className="inline-flex items-center gap-1"><Ship size={12} /> Nearshore</span></th>
                      <th className="px-4 py-2 font-medium"><span className="inline-flex items-center gap-1"><Globe size={12} /> Offshore</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {spec.requirements.map((r) => (
                      <tr key={r.id} className="border-b border-gray-50 last:border-0">
                        <td className="px-4 py-2 text-gray-600 align-top">{r.trainingType ? trainingTypeLabel(r.trainingType) : "—"}</td>
                        <td className="px-4 py-2 align-top">
                          <div className="text-gray-900">{r.trainingFullTitle}</div>
                          {r.alternatives.length > 0 && (
                            <div className="text-xs text-gray-400">or {r.alternatives.map((a) => a.trainingFullTitle).join(", ")}</div>
                          )}
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className={`font-medium ${r.met ? "text-green-700" : "text-red-700"}`}>
                            {r.onshore ?? 0} / {r.quantityRequired}
                          </span>
                          {(r.onshore ?? 0) > 0 && (
                            <button onClick={() => viewStudents(r, "onshore")} className="ml-2 inline-flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800" title="View students">
                              <Users size={12} /> View
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-2 align-top text-gray-600">
                          {r.nearshore === null ? (
                            <span className="text-gray-400">—</span>
                          ) : (
                            <>
                              {r.nearshore}
                              {r.nearshore > 0 && (
                                <button onClick={() => viewStudents(r, "nearshore")} className="ml-2 inline-flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800" title="View students">
                                  <Users size={12} /> View
                                </button>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-4 py-2 align-top text-gray-600">
                          {r.offshore === null ? (
                            <span className="text-gray-400">—</span>
                          ) : (
                            <>
                              {r.offshore}
                              {r.offshore > 0 && (
                                <button onClick={() => viewStudents(r, "offshore")} className="ml-2 inline-flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800" title="View students">
                                  <Users size={12} /> View
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
            ))
          )}
        </div>
      )}

      {/* Students modal */}
      <Modal open={students !== null || studentsLoading} onClose={() => { setStudents(null); }} title={studentsTitle}>
        {studentsLoading ? (
          <div className="py-8 text-center text-gray-500">Loading…</div>
        ) : students && students.length > 0 ? (
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium">Country</th>
                  <th className="px-2 py-2 font-medium">Completed</th>
                  <th className="px-2 py-2 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.email} className="border-b border-gray-50">
                    <td className="px-2 py-2"><Link href={`/students/${encodeURIComponent(s.email)}`} className="text-blue-600 hover:underline">{s.fullName}</Link></td>
                    <td className="px-2 py-2 text-gray-600">{s.country}</td>
                    <td className="px-2 py-2 text-gray-600">{s.completedDate}</td>
                    <td className="px-2 py-2 text-gray-600">{s.expiryDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-8 text-center text-gray-500">No students found.</div>
        )}
      </Modal>
    </div>
  );
}

export default function OfferingDashboardPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading offering…" />}>
      <OfferingDashboardInner />
    </Suspense>
  );
}
