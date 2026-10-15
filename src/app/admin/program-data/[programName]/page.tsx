"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import RequirementModal, { RequirementScope } from "../RequirementModal";
import TierModal from "../TierModal";
import AnchorSettingsFields, { type AnchorSettingsValue } from "../AnchorSettingsFields";
import { ProgramDataRow, ProgramTierRow, SpecialisationRow } from "@/types";
import { trainingTypeLabel } from "@/lib/utils";
import { Plus, Trash2, Pencil, ChevronUp, ChevronDown, Layers, Anchor, AlertTriangle, Users, Save } from "lucide-react";
import {
  AGGREGATIONS,
  AGGREGATION_SHORT_LABELS,
  LEVEL_LABELS,
  REQ_LEVELS,
  isAnchoredReqLevel,
  isMultiCountryLevel,
  isProgramWideRow,
  isReqLevel,
  normaliseAggregation,
} from "@/lib/program-levels";

const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining"];

const levelLabel = (level: string) => (isReqLevel(level) ? LEVEL_LABELS[level] : level);
const levelRank = (level: string) => (isReqLevel(level) ? REQ_LEVELS.indexOf(level) : REQ_LEVELS.length);

/** Filter key for the Count Mode column: the row's count mode on a
 *  multi-country level, or "na" where a count mode does not apply. */
const NOT_APPLICABLE = "na";
const countModeKey = (row: ProgramDataRow) =>
  isMultiCountryLevel(row.level) ? normaliseAggregation(row.level, row.aggregation) : NOT_APPLICABLE;

/** Table-cell text: "—" for single-country levels, else "Total" / "Each country". */
const countModeLabel = (row: ProgramDataRow) => {
  const key = countModeKey(row);
  return key === NOT_APPLICABLE ? "—" : AGGREGATION_SHORT_LABELS[key];
};

const PURPOSE_LABELS: Record<string, string> = {
  qualification: "Qualification",
  deployment: "Deployment",
};

type SortDir = "asc" | "desc";

export default function ProgramRequirementsPage() {
  const params = useParams<{ programName: string }>();
  const programName = useMemo(() => {
    try {
      return decodeURIComponent(params.programName);
    } catch {
      return params.programName;
    }
  }, [params.programName]);

  const [rows, setRows] = useState<ProgramDataRow[]>([]);
  const [specialisations, setSpecialisations] = useState<SpecialisationRow[]>([]);
  const [tiers, setTiers] = useState<ProgramTierRow[]>([]);
  const [isTiered, setIsTiered] = useState(false);
  const [deploymentMode, setDeploymentMode] = useState("flat");
  const [loading, setLoading] = useState(true);

  // Anchored-program settings: the stored values, and the editable form.
  const [anchorTheatre, setAnchorTheatre] = useState<string | null>(null);
  const [anchorForm, setAnchorForm] = useState<AnchorSettingsValue>({ anchorTheatre: "", minimum: "" });
  const [anchorSaving, setAnchorSaving] = useState(false);
  const [anchorError, setAnchorError] = useState("");
  const [anchorSaved, setAnchorSaved] = useState(false);

  // Filters
  const [filterSpec, setFilterSpec] = useState("");
  const [filterLevel, setFilterLevel] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterCountMode, setFilterCountMode] = useState("");

  // Sort
  const [sortCol, setSortCol] = useState("specialisationName");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Requirement modal
  const [showRequirement, setShowRequirement] = useState(false);
  const [editTarget, setEditTarget] = useState<ProgramDataRow | null>(null);
  const [reqScope, setReqScope] = useState<RequirementScope>({ kind: "specialisation" });
  const [deleteTarget, setDeleteTarget] = useState<ProgramDataRow | null>(null);
  const [deleteError, setDeleteError] = useState("");

  // Tier modal
  const [showTier, setShowTier] = useState(false);
  const [tierEditTarget, setTierEditTarget] = useState<ProgramTierRow | null>(null);
  const [deleteTierTarget, setDeleteTierTarget] = useState<ProgramTierRow | null>(null);

  // Promise chains rather than async/await: an async function called from an
  // effect is treated as writing state synchronously, whereas a chain provably
  // defers every write to a later microtask.
  const fetchData = () =>
    fetch("/api/admin/program-data")
      .then((res) => (res.ok ? (res.json() as Promise<ProgramDataRow[]>) : null))
      .then((all) => { if (all) setRows(all.filter((r) => r.programName === programName)); })
      .finally(() => setLoading(false));

  const fetchSpecialisations = () =>
    fetch("/api/admin/specialisations")
      .then((res) => (res.ok ? res.json() : null))
      .then((rows) => { if (rows) setSpecialisations(rows); })
      .catch(() => { /* ignore */ });

  const fetchTiers = () =>
    fetch(`/api/admin/program-tiers?programName=${encodeURIComponent(programName)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((rows) => { if (rows) setTiers(rows); })
      .catch(() => { /* ignore */ });

  const fetchProgram = () =>
    fetch("/api/admin/program-data/program")
      .then((res) =>
        res.ok
          ? (res.json() as Promise<
              {
                name: string;
                isTiered: boolean;
                deploymentMode: string;
                anchorTheatre?: string | null;
                defaultMinimumCountries?: number | null;
              }[]
            >)
          : null
      )
      .then((list) => {
        const me = list?.find((p) => p.name === programName);
        if (me) {
          setIsTiered(me.isTiered);
          setDeploymentMode(me.deploymentMode || "flat");
          setAnchorTheatre(me.anchorTheatre ?? null);
          setAnchorForm({
            anchorTheatre: me.anchorTheatre ?? "",
            minimum: me.defaultMinimumCountries != null ? String(me.defaultMinimumCountries) : "",
          });
        }
      })
      .catch(() => { /* ignore */ });

  useEffect(() => {
    fetchData();
    fetchSpecialisations();
    fetchTiers();
    fetchProgram();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programName]);

  const allowPurpose = isTiered && deploymentMode === "perAchievedSpecialisation";
  // In "perTierPerSpecialisation" mode a tier deployment requirement is scoped
  // to a specialisation, so the tier-requirement modal must offer a spec picker.
  const tierRequiresSpecialisation = isTiered && deploymentMode === "perTierPerSpecialisation";
  // Tiers list their own deployment requirements in every mode except
  // "perAchievedSpecialisation" (where they come from the specialisations).
  const showTierDeploymentLists = deploymentMode !== "perAchievedSpecialisation";

  const changeDeploymentMode = async (mode: string) => {
    setDeploymentMode(mode);
    await fetch(`/api/admin/program-data/program/${encodeURIComponent(programName)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deploymentMode: mode }),
    });
  };

  const saveAnchorSettings = async () => {
    setAnchorError("");
    setAnchorSaved(false);
    setAnchorSaving(true);
    try {
      const res = await fetch(`/api/admin/program-data/program/${encodeURIComponent(programName)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anchorTheatre: anchorForm.anchorTheatre || null,
          // Un-anchoring clears the default minimum too: it only means
          // anything on an anchored program.
          defaultMinimumCountries: anchorForm.anchorTheatre ? anchorForm.minimum.trim() || null : null,
        }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAnchorError(typeof result.error === "string" ? result.error : "Could not save the settings");
        return;
      }
      setAnchorSaved(true);
      fetchProgram();
    } catch {
      setAnchorError("Could not save the settings");
    } finally {
      setAnchorSaving(false);
    }
  };

  const toggleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  // A plain helper, not a component: a component declared during render is
  // recreated every render (and would reset any state it held).
  const sortIcon = (col: string) =>
    sortCol === col ? (sortDir === "asc" ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : null;

  // Specialisation-scoped rows (no tier) drive the main requirements table;
  // tier-scoped rows — including per-tier-per-specialisation deployment rows
  // that carry both a tier and a specialisation — are shown under their tier.
  const specRows = useMemo(() => rows.filter((r) => r.specialisationId != null && r.tierId == null), [rows]);
  // Program-wide gates: neither a specialisation nor a tier (tiered programs only).
  const gateRows = useMemo(() => rows.filter((r) => isProgramWideRow(r)), [rows]);
  // Rows an anchored view never evaluates: anything but Theatre / Country Set.
  const unusedLevelCounts = useMemo(() => {
    if (!anchorTheatre) return [] as { level: string; count: number }[];
    const counts = new Map<string, number>();
    for (const r of rows) if (!isAnchoredReqLevel(r.level)) counts.set(r.level, (counts.get(r.level) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => levelRank(a[0]) - levelRank(b[0]))
      .map(([level, count]) => ({ level, count }));
  }, [rows, anchorTheatre]);
  const tierReqsByTier = useMemo(() => {
    const map = new Map<number, ProgramDataRow[]>();
    for (const r of rows) {
      if (r.tierId == null) continue;
      if (!map.has(r.tierId)) map.set(r.tierId, []);
      map.get(r.tierId)!.push(r);
    }
    return map;
  }, [rows]);

  const specOptions = useMemo(
    () => [...new Set(specRows.map((r) => r.specialisationName).filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b)),
    [specRows]
  );

  const filteredRows = useMemo(
    () =>
      specRows.filter(
        (r) =>
          (!filterSpec || r.specialisationName === filterSpec) &&
          (!filterLevel || r.level === filterLevel) &&
          (!filterType || r.trainingType === filterType) &&
          (!filterCountMode || countModeKey(r) === filterCountMode)
      ),
    [specRows, filterSpec, filterLevel, filterType, filterCountMode]
  );

  const hasFilters = !!filterSpec || !!filterLevel || !!filterType || !!filterCountMode;

  const sortedRows = useMemo(() => {
    const sorted = [...filteredRows];
    sorted.sort((a, b) => {
      let aVal = "", bVal = "";
      switch (sortCol) {
        case "specialisationName": aVal = a.specialisationName || ""; bVal = b.specialisationName || ""; break;
        case "level":
          return sortDir === "asc" ? levelRank(a.level) - levelRank(b.level) : levelRank(b.level) - levelRank(a.level);
        case "countMode": aVal = countModeLabel(a); bVal = countModeLabel(b); break;
        case "trainingType": aVal = a.trainingType || ""; bVal = b.trainingType || ""; break;
        case "trainingFullTitle": aVal = a.trainingFullTitle || ""; bVal = b.trainingFullTitle || ""; break;
        case "quantityRequired": return sortDir === "asc" ? a.quantityRequired - b.quantityRequired : b.quantityRequired - a.quantityRequired;
      }
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });
    return sorted;
  }, [filteredRows, sortCol, sortDir]);

  const openAddSpec = () => { setEditTarget(null); setReqScope({ kind: "specialisation" }); setShowRequirement(true); };
  const openAddGate = () => { setEditTarget(null); setReqScope({ kind: "programWide" }); setShowRequirement(true); };
  const openAddTierReq = (tier: ProgramTierRow) => {
    setEditTarget(null);
    setReqScope({ kind: "tier", tierId: tier.id, tierName: tier.name });
    setShowRequirement(true);
  };
  const openEdit = (row: ProgramDataRow) => {
    setEditTarget(row);
    if (row.tierId != null) {
      setReqScope({ kind: "tier", tierId: row.tierId, tierName: row.tierName ?? "Tier" });
    } else if (isProgramWideRow(row)) {
      setReqScope({ kind: "programWide" });
    } else {
      setReqScope({ kind: "specialisation" });
    }
    setShowRequirement(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteError("");
    const res = await fetch(`/api/admin/program-data/${deleteTarget.id}`, { method: "DELETE" });
    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      setDeleteError(result.error || "Failed to delete requirement");
      return;
    }
    setDeleteTarget(null);
    fetchData();
  };

  const handleDeleteTier = async () => {
    if (!deleteTierTarget) return;
    await fetch(`/api/admin/program-tiers/${deleteTierTarget.id}`, { method: "DELETE" });
    setDeleteTierTarget(null);
    fetchTiers();
    fetchData();
  };

  const refreshAfterReq = () => { fetchData(); };

  if (loading) {
    return (
      <div>
        <PageHeader title={programName} showBack helpSlug="admin-program-data" />
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  const describeRow = (r: ProgramDataRow) => (
    <>
      <span className="text-gray-500">
        {anchorTheatre && r.level === "Theatre"
          ? `Across ${anchorTheatre}`
          : anchorTheatre && r.level === "CountrySet"
            ? "Target countries"
            : levelLabel(r.level)}
        {isMultiCountryLevel(r.level) && ` (${countModeLabel(r).toLowerCase()})`}
        {" · "}
      </span>
      {r.quantityRequired}× {r.trainingFullTitle || "—"}
      {r.alternatives.length > 0 && (
        <span className="text-xs text-gray-500"> or {r.alternatives.map((a) => a.trainingFullTitle).join(", ")}</span>
      )}
    </>
  );

  return (
    <div>
      <PageHeader title={programName} showBack helpSlug="admin-program-data" />

      <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800">
            <Anchor size={18} /> Anchoring
          </h2>
          {anchorTheatre && (
            <Link
              href={`/admin/program-partners?q=${encodeURIComponent(programName)}`}
              className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
            >
              <Users size={15} /> Partner settings
            </Link>
          )}
        </div>
        <div className="max-w-md">
          <AnchorSettingsFields value={anchorForm} onChange={(v) => { setAnchorForm(v); setAnchorSaved(false); }} idPrefix="program-settings" />
        </div>
        {anchorError && <div className="mt-3 p-2 bg-red-50 text-red-700 rounded text-sm">{anchorError}</div>}
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={saveAnchorSettings}
            disabled={anchorSaving}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Save size={15} /> {anchorSaving ? "Saving…" : "Save anchoring"}
          </button>
          {anchorSaved && <span className="text-sm text-green-700">Saved.</span>}
        </div>
        {anchorTheatre && (
          <p className="mt-3 text-xs text-gray-500">
            Each partner&apos;s own minimum and target Country Set are set on the Program Partners page.
          </p>
        )}
      </section>

      {unusedLevelCounts.length > 0 && (
        <div className="mb-6 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-sm">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>
            This program is anchored to {anchorTheatre}, so only Theatre and Country Set requirements are counted. Not
            used:{" "}
            {unusedLevelCounts
              .map(({ level, count }) => `${count} ${levelLabel(level)} requirement${count === 1 ? "" : "s"}`)
              .join(", ")}
            . Edit them to Theatre or Country Set, or delete them.
          </div>
        </div>
      )}

      {isTiered && (
        <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-base font-semibold text-gray-800">Required at every level</h2>
            <button
              onClick={openAddGate}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus size={16} /> Add
            </button>
          </div>
          <p className="mb-3 text-xs text-gray-500">
            Every tier needs these, whichever specialisations are achieved.
          </p>
          {gateRows.length === 0 ? (
            <p className="text-sm text-gray-500">None.</p>
          ) : (
            <ul className="space-y-1">
              {gateRows.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm">
                  <span>
                    {describeRow(r)}
                    {anchorTheatre && !isAnchoredReqLevel(r.level) && (
                      <span className="ml-2 text-xs text-amber-700">(not counted — level not used)</span>
                    )}
                  </span>
                  <span className="flex gap-2">
                    <button onClick={() => openEdit(r)} className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Edit</button>
                    <button onClick={() => { setDeleteTarget(r); setDeleteError(""); }} className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"><Trash2 size={12} /></button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {isTiered && (
        <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="flex items-center gap-2 text-base font-semibold text-gray-800">
              <Layers size={18} /> Tiers
            </h2>
            <button
              onClick={() => { setTierEditTarget(null); setShowTier(true); }}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <Plus size={16} /> Add Tier
            </button>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium mb-1">Deployment requirement handling</label>
            <select
              value={deploymentMode}
              onChange={(e) => changeDeploymentMode(e.target.value)}
              className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm"
            >
              <option value="flat">Flat — each tier lists its own deployment requirements</option>
              <option value="perAchievedSpecialisation">Per achieved specialisation — each achieved specialisation&apos;s deployment requirements must be met</option>
              <option value="perTierPerSpecialisation">Per tier, per achieved specialisation — each tier lists its own deployment requirements for each specialisation</option>
            </select>
          </div>

          {tiers.length === 0 ? (
            <p className="text-sm text-gray-500">No tiers yet. Add a tier to define the ladder (e.g. Tier A, Tier B, Tier C).</p>
          ) : (
            <div className="space-y-4">
              {tiers.map((tier) => {
                const reqs = tierReqsByTier.get(tier.id) ?? [];
                return (
                  <div key={tier.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-semibold text-gray-800">{tier.name}</span>
                        <span className="ml-2 text-sm text-gray-500">
                          requires {tier.specialisationsRequired} specialisation{tier.specialisationsRequired === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setTierEditTarget(tier); setShowTier(true); }}
                          className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => setDeleteTierTarget(tier)}
                          className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>

                    {showTierDeploymentLists && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-gray-600 uppercase tracking-wide">Deployment requirements</span>
                          <button
                            onClick={() => openAddTierReq(tier)}
                            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                          >
                            <Plus size={13} /> Add
                          </button>
                        </div>
                        {reqs.length === 0 ? (
                          <p className="text-xs text-gray-400">None yet.</p>
                        ) : (
                          <ul className="space-y-1">
                            {reqs.map((r) => (
                              <li key={r.id} className="flex items-center justify-between text-sm">
                                <span>
                                  {r.specialisationName && (
                                    <span className="font-medium text-gray-700">{r.specialisationName}: </span>
                                  )}
                                  {describeRow(r)}
                                </span>
                                <span className="flex gap-2">
                                  <button onClick={() => openEdit(r)} className="px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Edit</button>
                                  <button onClick={() => { setDeleteTarget(r); setDeleteError(""); }} className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"><Trash2 size={12} /></button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {tierRequiresSpecialisation && reqs.length > 0 && (
                          <p className="mt-1 text-xs text-gray-400">
                            Enforced once per achieved specialisation.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {deploymentMode === "perAchievedSpecialisation" && (
            <p className="mt-3 text-xs text-gray-500">
              In this mode, add each specialisation&apos;s deployment certs as requirements with purpose
              &ldquo;Deployment&rdquo; below.
            </p>
          )}
        </section>
      )}

      <section className="mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={openAddSpec}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus size={16} /> Add Requirement
          </button>
          {hasFilters && (
            <button
              onClick={() => { setFilterSpec(""); setFilterLevel(""); setFilterType(""); setFilterCountMode(""); }}
              className="text-sm text-blue-600 hover:text-blue-800 whitespace-nowrap"
            >
              Clear Filters
            </button>
          )}
        </div>
      </section>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("specialisationName")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Specialisation {sortIcon("specialisationName")}
                    </button>
                    <select value={filterSpec} onChange={(e) => setFilterSpec(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {specOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </th>
                {isTiered && (
                  <th className="px-4 py-3 font-semibold text-gray-700">Purpose</th>
                )}
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("level")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Level {sortIcon("level")}
                    </button>
                    <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {REQ_LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("countMode")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900 whitespace-nowrap">
                      Count Mode {sortIcon("countMode")}
                    </button>
                    <select value={filterCountMode} onChange={(e) => setFilterCountMode(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {AGGREGATIONS.map((a) => <option key={a} value={a}>{AGGREGATION_SHORT_LABELS[a]}</option>)}
                      <option value={NOT_APPLICABLE}>Not applicable</option>
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <div className="space-y-1">
                    <button onClick={() => toggleSort("trainingType")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                      Type {sortIcon("trainingType")}
                    </button>
                    <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="w-full text-xs border border-gray-200 rounded px-1 py-0.5 font-normal">
                      <option value="">All</option>
                      {TRAINING_TYPES.map((t) => <option key={t} value={t}>{trainingTypeLabel(t)}</option>)}
                    </select>
                  </div>
                </th>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => toggleSort("trainingFullTitle")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                    Training {sortIcon("trainingFullTitle")}
                  </button>
                </th>
                <th className="px-4 py-3 text-left">
                  <button onClick={() => toggleSort("quantityRequired")} className="flex items-center gap-1 font-semibold text-gray-700 hover:text-gray-900">
                    Qty Required {sortIcon("quantityRequired")}
                  </button>
                </th>
                <th className="px-4 py-3 font-semibold text-gray-700">Min/Theatre</th>
                <th className="px-4 py-3 font-semibold text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={isTiered ? 9 : 8} className="px-4 py-8 text-center text-gray-500">
                    {specRows.length === 0
                      ? <>No requirements yet for this program. Click &quot;Add Requirement&quot; to define the first one.</>
                      : "No requirements match the current filters."}
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => (
                  <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">{row.specialisationName}</td>
                    {isTiered && (
                      <td className="px-4 py-3">{PURPOSE_LABELS[row.purpose] || row.purpose}</td>
                    )}
                    <td className="px-4 py-3">{levelLabel(row.level)}</td>
                    <td
                      className="px-4 py-3"
                      title={isMultiCountryLevel(row.level) ? undefined : "Count mode applies only to Region and Country Set requirements"}
                    >
                      {countModeLabel(row)}
                    </td>
                    <td className="px-4 py-3">{row.trainingType ? trainingTypeLabel(row.trainingType) : "—"}</td>
                    <td className="px-4 py-3">
                      {row.trainingFullTitle || "—"}
                      {row.alternatives && row.alternatives.length > 0 && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          or {row.alternatives.map((a) => a.trainingFullTitle).join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">{row.quantityRequired}</td>
                    <td className="px-4 py-3">{row.minimumPerTheatre ?? "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => openEdit(row)}
                          className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => { setDeleteTarget(row); setDeleteError(""); }}
                          className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Requirement — mounted only while open, and keyed on the row
          being edited, so the form seeds itself from `initial` on mount. */}
      {showRequirement && (
      <RequirementModal
        key={editTarget?.id ?? "new"}
        open
        onClose={() => setShowRequirement(false)}
        programName={programName}
        specialisations={specialisations}
        initial={editTarget}
        onSaved={refreshAfterReq}
        onSpecialisationAdded={fetchSpecialisations}
        scope={reqScope}
        allowPurpose={allowPurpose}
        tierRequiresSpecialisation={tierRequiresSpecialisation}
        isTiered={isTiered}
        anchorTheatre={anchorTheatre}
      />
      )}

      {/* Add / Edit Tier — same mount-on-open treatment as above. */}
      {showTier && (
      <TierModal
        key={tierEditTarget?.id ?? "new"}
        open
        onClose={() => setShowTier(false)}
        programName={programName}
        initial={tierEditTarget}
        onSaved={() => { fetchTiers(); fetchProgram(); }}
      />
      )}

      {/* Delete Requirement */}
      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="Delete Requirement">
        {deleteTarget && (
          <div>
            {deleteError && <div className="mb-3 p-2 bg-red-50 text-red-700 rounded text-sm">{deleteError}</div>}
            <p className="text-sm mb-4">
              Are you sure you want to delete the requirement for{" "}
              <strong>{deleteTarget.trainingFullTitle || "this global requirement"}</strong> under{" "}
              <strong>
                {deleteTarget.specialisationName ??
                  deleteTarget.tierName ??
                  (isProgramWideRow(deleteTarget) ? "every level of this program" : "this program")}
              </strong>?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleDelete} className="flex items-center gap-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">
                <Trash2 size={16} /> Delete
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Tier */}
      <Modal open={deleteTierTarget !== null} onClose={() => setDeleteTierTarget(null)} title="Delete Tier">
        {deleteTierTarget && (
          <div>
            <p className="text-sm mb-4">
              Delete tier <strong>{deleteTierTarget.name}</strong> and its deployment requirements? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTierTarget(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleDeleteTier} className="flex items-center gap-1 px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700">
                <Trash2 size={16} /> Delete
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
