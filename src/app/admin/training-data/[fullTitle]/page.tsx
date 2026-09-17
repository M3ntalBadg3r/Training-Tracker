"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { TrainingDataRow } from "@/types";
import { Plus, Trash2, Save, AlertTriangle, ArrowRight } from "lucide-react";
import { safeExternalUrl } from "@/lib/utils";
import FullTitlePicker, { type FullTitleOption } from "@/components/training/FullTitlePicker";

const TRAINING_TYPES = ["Certification", "Accreditation", "InstructorLedTraining", "OLX", "OLXSubItem"];
const FUNCTION_TYPES = ["Sales", "PreSales", "Deployments"];
const LEGACY_ELIGIBLE = ["Certification", "Accreditation"];

const TRAINING_TYPE_LABELS: Record<string, string> = {
  Certification: "Certification",
  Accreditation: "Accreditation",
  InstructorLedTraining: "Instructor-Led Training",
  OLX: "OLX",
  OLXSubItem: "OLX Sub-Item",
};

const FUNCTION_TYPE_LABELS: Record<string, string> = {
  Sales: "Sales",
  PreSales: "Pre-Sales",
  Deployments: "Deployments",
};

interface GroupMeta {
  types: string[];
  products: string[];
  functions: string[];
  memberCount: number;
  legacyEligibleCount: number;
}

/**
 * One `(fullTitle, trainingType)` pair — the unit the rest of the app counts on
 * (see `resolveSiblingTitles` in lib/program-compliance.ts). The server returns
 * one of these per type present in the group, with the shared field values and
 * a `*Varies` flag wherever the member training titles disagree.
 */
interface TrainingGroup {
  trainingType: string;
  trainingTitles: string[];
  memberCount: number;
  productType: string;
  productTypeVaries: boolean;
  function: string;
  functionVaries: boolean;
  link: string | null;
  linkVaries: boolean;
  legacyState: "none" | "some" | "all";
  certificationFullTitles: string[];
  certificationVaries: boolean;
  replacedByFullTitles: string[];
}

/** Types that can lead to a certification — matches the server's rule. */
const CERT_BEARING = ["InstructorLedTraining", "OLX"];

/**
 * Collapse catalogue rows to one picker option per Full Title.
 *
 * `excludeFullTitle` keeps a group out of its own picker: a training must not be
 * able to lead to, or be replaced by, itself.
 */
function buildFullTitleOptions(
  rows: TrainingDataRow[],
  types: string[],
  excludeFullTitle?: string,
): FullTitleOption[] {
  const byFull = new Map<string, { types: Set<string>; count: number }>();
  for (const r of rows) {
    if (!types.includes(r.trainingType)) continue;
    if (excludeFullTitle && r.fullTitle === excludeFullTitle) continue;
    const entry = byFull.get(r.fullTitle) ?? { types: new Set<string>(), count: 0 };
    entry.types.add(r.trainingType);
    entry.count += 1;
    byFull.set(r.fullTitle, entry);
  }
  return Array.from(byFull.entries())
    .map(([fullTitle, e]) => ({
      fullTitle,
      trainingTypes: Array.from(e.types),
      memberCount: e.count,
    }))
    .sort((a, b) => a.fullTitle.localeCompare(b.fullTitle));
}

const emptyEdit = {
  trainingTitle: "",
  fullTitle: "",
  trainingType: "",
  productType: "",
  function: "",
  link: "",
  certification: [] as string[],
  subItems: [] as string[],
  parents: [] as string[],
  isLegacy: false,
  replacedByFulls: [] as string[],
};

export default function FullTitleDetailPage() {
  const router = useRouter();
  const params = useParams<{ fullTitle: string }>();
  const fullTitle = useMemo(() => {
    const raw = params?.fullTitle;
    const value = Array.isArray(raw) ? raw[0] : raw;
    try {
      return value ? decodeURIComponent(value) : "";
    } catch {
      return value ?? "";
    }
  }, [params]);

  const [members, setMembers] = useState<TrainingDataRow[]>([]);
  const [meta, setMeta] = useState<GroupMeta | null>(null);
  const [groups, setGroups] = useState<TrainingGroup[]>([]);
  // "Leads to" is now set once per training type rather than once per training
  // title. Keyed by type so a mixed Full Title (a Certification plus the ILT
  // that prepares for it) keeps the two apart.
  const [leadsTo, setLeadsTo] = useState<Record<string, string[]>>({});
  const [allRows, setAllRows] = useState<TrainingDataRow[]>([]);
  const [productTypes, setProductTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Bulk action state
  const [renameValue, setRenameValue] = useState("");
  const [bulkLegacy, setBulkLegacy] = useState(false);
  const [bulkReplacement, setBulkReplacement] = useState<string[]>([]);
  const [bulkProduct, setBulkProduct] = useState("");
  const [bulkFunction, setBulkFunction] = useState("");
  const [busy, setBusy] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  // Per-member inline edit state
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ ...emptyEdit });

  // Add-a-training-title modal
  const [showAdd, setShowAdd] = useState(false);
  const [newTraining, setNewTraining] = useState({ ...emptyEdit, trainingType: "Certification", function: "Sales" });

  // trainingTitle → fullTitle map (for rendering replacedBy across the catalogue).
  const titleToFull = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of allRows) m.set(t.trainingTitle, t.fullTitle);
    return m;
  }, [allRows]);

  // Full Titles (excluding this group) that contain at least one Cert/Accred —
  // valid replacement targets for a legacy item.
  const replacementFullTitleOptions = useMemo<FullTitleOption[]>(
    () => buildFullTitleOptions(allRows, LEGACY_ELIGIBLE, fullTitle),
    [allRows, fullTitle]
  );

  /**
   * Full Titles that contain at least one Certification — the valid "leads to"
   * targets. One entry per Full Title, not per training title: the old list
   * mapped `trainingTitle` while labelling each row with its Full Title, so a
   * certification that arrived under three import spellings appeared three
   * times with identical text.
   */
  const certificationOptions = useMemo<FullTitleOption[]>(
    () => buildFullTitleOptions(allRows, ["Certification"], fullTitle),
    [allRows, fullTitle]
  );
  const subItemOptions = useMemo(
    () => allRows.filter((t) => t.trainingType === "OLXSubItem").map((t) => ({ trainingTitle: t.trainingTitle, fullTitle: t.fullTitle })).sort((a, b) => a.fullTitle.localeCompare(b.fullTitle)),
    [allRows]
  );
  const parentOptions = useMemo(
    () => allRows.filter((t) => t.trainingType === "OLX").map((t) => ({ trainingTitle: t.trainingTitle, fullTitle: t.fullTitle })).sort((a, b) => a.fullTitle.localeCompare(b.fullTitle)),
    [allRows]
  );

  // Expand selected replacement Full Titles → underlying Cert/Accred training
  // titles (server re-validates via sanitizeLegacyFields).
  const expandFullTitles = (fulls: string[]): string[] => {
    const set = new Set(fulls);
    return allRows
      .filter((t) => set.has(t.fullTitle) && LEGACY_ELIGIBLE.includes(t.trainingType))
      .map((t) => t.trainingTitle);
  };

  // Written as a promise chain rather than async/await: an async function called
  // from an effect is treated as writing state synchronously, whereas a chain
  // provably defers every write to a later microtask.
  const fetchAll = () =>
    Promise.all([
      fetch(`/api/training-data/full-title/${encodeURIComponent(fullTitle)}`),
      fetch("/api/training-data/all"),
      fetch("/api/admin/product-types"),
    ])
      .then(([groupRes, allRes, ptRes]) =>
        Promise.all([
          groupRes.ok ? groupRes.json() : null,
          allRes.ok ? allRes.json() : null,
          ptRes.ok ? (ptRes.json() as Promise<{ name: string }[]>) : null,
        ]).then(([group, all, pts]) => ({
          notFound: groupRes.status === 404,
          group,
          all,
          pts,
        }))
      )
      .then(({ notFound: missing, group, all, pts }) => {
        if (missing) {
          setNotFound(true);
          return;
        }
        if (group) {
          setMembers(group.members);
          setMeta(group.meta);
          setGroups(group.groups ?? []);
          setRenameValue(group.fullTitle);
          // Seed the bulk legacy controls from the current eligible members.
          // `.every()` is deliberate for the checkbox itself — a partly-legacy
          // group is NOT "legacy" — but on its own it was lossy: the list page
          // badges the same group from `.some()`, so a group where two of five
          // certs were legacy showed a Legacy badge, read as unchecked here, and
          // pressing Save silently cleared the two that were. The mixed state is
          // now called out in the UI instead of being flattened in silence.
          const eligible = (group.members as TrainingDataRow[]).filter((m) =>
            LEGACY_ELIGIBLE.includes(m.trainingType)
          );
          setBulkLegacy(eligible.length > 0 && eligible.every((m) => m.isLegacy));
        }
        if (all) setAllRows(all);
        if (pts) setProductTypes(pts.map((pt) => pt.name));
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    if (fullTitle) fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullTitle]);

  // Seed the replacement multiselect from existing legacy members' replacedBy.
  // Uses React's "adjust state while rendering" pattern rather than a
  // setState-in-effect: the multiselect is user-editable after seeding, so it
  // must be re-seeded only when a new `members` array actually arrives.
  const [prevMembers, setPrevMembers] = useState(members);
  if (prevMembers !== members) {
    setPrevMembers(members);
    if (members.length > 0) {
      const fulls = new Set<string>();
      for (const m of members) {
        if (m.isLegacy) {
          for (const rt of m.replacedBy ?? []) {
            const f = titleToFull.get(rt);
            if (f) fulls.add(f);
          }
        }
      }
      setBulkReplacement(Array.from(fulls));
    }
  }

  // Same pattern for the per-type "leads to" selections: seeded from the server,
  // edited by the user, so re-seeded only when a new `groups` array arrives.
  const [prevGroups, setPrevGroups] = useState(groups);
  if (prevGroups !== groups) {
    setPrevGroups(groups);
    const next: Record<string, string[]> = {};
    for (const g of groups) next[g.trainingType] = g.certificationFullTitles;
    setLeadsTo(next);
  }

  // ---- Bulk actions ----
  const patchGroup = async (body: Record<string, unknown>): Promise<string | null> => {
    setError(null);
    // Close any open row editor first. Its `editValues` were seeded when the row
    // was opened, so after a group write they are stale — and the per-member PUT
    // sends every field, which would write the pre-group values straight back.
    setEditingTitle(null);
    setBusy(true);
    const res = await fetch(`/api/training-data/full-title/${encodeURIComponent(fullTitle)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Update failed");
      return null;
    }
    const data = await res.json();
    return data.fullTitle ?? fullTitle;
  };

  const handleRename = async () => {
    const next = renameValue.trim();
    if (!next || next === fullTitle) return;
    const newFull = await patchGroup({ rename: next });
    if (newFull) router.replace(`/admin/training-data/${encodeURIComponent(newFull)}`);
  };

  const handleSaveLegacy = async () => {
    const ok = await patchGroup({
      legacy: { isLegacy: bulkLegacy, replacedByFullTitles: bulkLegacy ? bulkReplacement : [] },
    });
    if (ok) fetchAll();
  };

  /**
   * Set "leads to Certification(s)" for one training type in one call.
   *
   * This is the change the whole page exists for: it used to be a per-training-
   * title edit, so an OLX whose Full Title covered four import spellings needed
   * the same certification ticked four times, in four separate saves, with a
   * full refetch between each.
   */
  const handleSaveLeadsTo = async (trainingType: string) => {
    const ok = await patchGroup({
      scope: { trainingType },
      setCertificationFullTitles: leadsTo[trainingType] ?? [],
    });
    if (ok) fetchAll();
  };

  const handleBulkProduct = async () => {
    if (!bulkProduct) return;
    const ok = await patchGroup({ setProductType: bulkProduct });
    if (ok) { setBulkProduct(""); fetchAll(); }
  };

  const handleBulkFunction = async () => {
    if (!bulkFunction) return;
    const ok = await patchGroup({ setFunction: bulkFunction });
    if (ok) { setBulkFunction(""); fetchAll(); }
  };

  // Every member ignored, so the button offers Restore rather than Ignore.
  const allIgnored = members.length > 0 && members.every((m) => m.isIgnored);

  const handleBulkIgnored = async () => {
    const ok = await patchGroup({ setIgnored: !allIgnored });
    if (ok) fetchAll();
  };

  const handleDeleteGroup = async () => {
    setBusy(true);
    const res = await fetch(`/api/training-data/full-title/${encodeURIComponent(fullTitle)}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) router.push("/admin/training-data");
    else setError("Delete failed");
  };

  // ---- Per-member actions ----
  const beginEdit = (t: TrainingDataRow) => {
    setEditingTitle(t.trainingTitle);
    const replFulls = Array.from(new Set((t.replacedBy ?? []).map((rt) => titleToFull.get(rt) ?? rt)));
    setEditValues({
      trainingTitle: t.trainingTitle,
      fullTitle: t.fullTitle,
      trainingType: t.trainingType,
      productType: t.productType,
      function: t.function,
      link: t.link || "",
      certification: t.certification || [],
      subItems: t.subItems || [],
      parents: t.parents || [],
      isLegacy: t.isLegacy ?? false,
      replacedByFulls: replFulls,
    });
  };

  const handleSaveMember = async (originalTitle: string) => {
    setError(null);
    const payload = {
      trainingTitle: editValues.trainingTitle,
      fullTitle: editValues.fullTitle,
      trainingType: editValues.trainingType,
      productType: editValues.productType,
      function: editValues.function,
      link: editValues.link,
      certification: editValues.certification,
      subItems: editValues.subItems,
      parents: editValues.parents,
      isLegacy: editValues.isLegacy,
      replacedBy: expandFullTitles(editValues.replacedByFulls),
    };
    const res = await fetch(`/api/training-data/${encodeURIComponent(originalTitle)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setEditingTitle(null);
      // If the member's fullTitle changed it leaves this group — reload, and if
      // the group is now empty navigate back to the list.
      fetchAll();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Save failed");
    }
  };

  const handleDeleteMember = async (trainingTitle: string) => {
    const res = await fetch(`/api/training-data/${encodeURIComponent(trainingTitle)}`, { method: "DELETE" });
    if (res.ok) fetchAll();
  };

  const handleAddMember = async () => {
    if (!newTraining.trainingTitle.trim()) return;
    setError(null);
    const payload = {
      trainingTitle: newTraining.trainingTitle,
      fullTitle,
      trainingType: newTraining.trainingType,
      productType: newTraining.productType || productTypes[0] || "",
      function: newTraining.function,
      link: newTraining.link,
      certification: newTraining.certification,
      subItems: newTraining.subItems,
      parents: newTraining.parents,
      isLegacy: newTraining.isLegacy,
      replacedBy: expandFullTitles(newTraining.replacedByFulls),
    };
    const res = await fetch("/api/training-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setShowAdd(false);
      setNewTraining({ ...emptyEdit, trainingType: "Certification", function: "Sales", productType: productTypes[0] || "" });
      fetchAll();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Add failed");
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading…</div></div>;
  }

  if (notFound) {
    return (
      <div>
        <PageHeader title="Full Title" showBack helpSlug="training-data" />
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
          No training data found for this Full Title.
        </div>
      </div>
    );
  }

  // Only ILT and OLX can lead to a certification, so only those get the control.
  const certBearingGroups = groups.filter((g) => CERT_BEARING.includes(g.trainingType));

  // Some members legacy, some not — the state the all-or-nothing checkbox
  // cannot represent, so it is stated rather than silently resolved.
  const partlyLegacy = groups.some(
    (g) => LEGACY_ELIGIBLE.includes(g.trainingType) && g.legacyState === "some"
  );

  const mixedEligibility = meta && meta.legacyEligibleCount > 0 && meta.legacyEligibleCount < meta.memberCount;
  const hasEligible = (meta?.legacyEligibleCount ?? 0) > 0;

  // Reusable replacement Full Title multiselect.
  const replacementPicker = (selected: string[], onChange: (next: string[]) => void) => (
    <FullTitlePicker
      options={replacementFullTitleOptions}
      value={selected}
      onChange={onChange}
      searchPlaceholder="Search certifications…"
      emptyMessage="No other certifications/accreditations available."
    />
  );

  return (
    <div>
      <PageHeader title={fullTitle} showBack helpSlug="training-data" />

      {error && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}

      {/* Summary */}
      <section className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Training titles</div>
          <div className="text-lg font-semibold">{meta?.memberCount ?? members.length}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Type(s)</div>
          <div className="text-sm font-medium">{(meta?.types ?? []).map((t) => TRAINING_TYPE_LABELS[t] || t).join(", ")}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Product(s)</div>
          <div className="text-sm font-medium">{(meta?.products ?? []).join(", ")}</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Function(s)</div>
          <div className="text-sm font-medium">{(meta?.functions ?? []).map((f) => FUNCTION_TYPE_LABELS[f] || f).join(", ")}</div>
        </div>
      </section>

      {/* The quick bulk fields, first: they are one control each and are what
          the page is most often opened to change. The two relationship editors
          below are scroll boxes, and having them above pushed Rename / Set
          Product / Set Function off the screen. */}
      <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4 space-y-5">
        <h2 className="text-sm font-semibold text-gray-700">Full Title actions</h2>

        {/* Rename */}
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Rename Full Title (applies to all {meta?.memberCount ?? members.length} training titles)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="flex-1 max-w-lg border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            <button
              onClick={handleRename}
              disabled={busy || !renameValue.trim() || renameValue.trim() === fullTitle}
              className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              Rename
            </button>
          </div>
        </div>

        {/* Bulk product / function */}
        <div className="border-t border-gray-100 pt-4 flex flex-wrap gap-6">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Set Product for all</label>
            <div className="flex items-center gap-2">
              <select value={bulkProduct} onChange={(e) => setBulkProduct(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">Select…</option>
                {productTypes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button onClick={handleBulkProduct} disabled={busy || !bulkProduct} className="px-3 py-2 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">Apply</button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Set Function for all</label>
            <div className="flex items-center gap-2">
              <select value={bulkFunction} onChange={(e) => setBulkFunction(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">Select…</option>
                {FUNCTION_TYPES.map((f) => <option key={f} value={f}>{FUNCTION_TYPE_LABELS[f]}</option>)}
              </select>
              <button onClick={handleBulkFunction} disabled={busy || !bulkFunction} className="px-3 py-2 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">Apply</button>
            </div>
          </div>
        </div>

      </section>

      {/* Leads to Certification(s) — one control per training type.

          A Full Title can legitimately cover more than one training type (a
          Certification and the Instructor-Led Training that prepares for it are
          two trainings sharing a display name, and the rest of the app counts
          them separately), so this is grouped by type rather than flattened. */}
      {certBearingGroups.length > 0 && (
        <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4 space-y-5">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Leads to Certification(s)</h2>
            <p className="text-xs text-gray-500 mt-1">
              The certification(s) this training prepares people for. It is
              recommended preparation &mdash; taking the training does not itself
              grant the certification.
            </p>
          </div>

          {certBearingGroups.map((g) => (
            <div key={g.trainingType} className="border-t border-gray-100 pt-4 first:border-t-0 first:pt-0">
              {certBearingGroups.length > 1 && (
                <div className="text-xs font-semibold text-gray-600 mb-1">
                  {TRAINING_TYPE_LABELS[g.trainingType] || g.trainingType}
                </div>
              )}
              <p className="text-xs text-gray-500 mb-2">
                Applies to all {g.memberCount} training title
                {g.memberCount === 1 ? "" : "s"}{" "}
                of this type under this Full Title.
              </p>
              {g.certificationVaries && (
                <p className="text-xs text-orange-600 mb-2">
                  These training titles currently disagree about what they lead
                  to. Saving applies one answer to all of them.
                </p>
              )}
              <FullTitlePicker
                options={certificationOptions}
                value={leadsTo[g.trainingType] ?? []}
                onChange={(next) =>
                  setLeadsTo((prev) => ({ ...prev, [g.trainingType]: next }))
                }
                searchPlaceholder="Search certifications…"
                emptyMessage="No certifications available to choose."
              />
              <button
                onClick={() => handleSaveLeadsTo(g.trainingType)}
                disabled={busy}
                className="mt-3 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          ))}
        </section>
      )}

      {/* Legacy — its own card rather than a row inside "Full Title
          actions", so the two relationship editors (this and Leads to)
          sit together below the quick bulk fields instead of pushing them
          off the screen. */}
      <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Legacy</h2>
        <div>
          {hasEligible ? (
            <>
              <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  checked={bulkLegacy}
                  onChange={(e) => setBulkLegacy(e.target.checked)}
                  className="rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                />
                Mark this Full Title as Legacy
              </label>
              <p className="text-xs text-gray-500 mt-1">
                Applies to the {meta?.legacyEligibleCount} Certification/Accreditation training title{(meta?.legacyEligibleCount ?? 0) === 1 ? "" : "s"} under this Full Title.
                {mixedEligibility && " Other types in this group are unaffected."}
              </p>
              {partlyLegacy && (
                <p className="text-xs text-orange-600 mt-1">
                  Some of these training titles are marked legacy and some are
                  not. Saving applies the box above to all of them.
                </p>
              )}
              {bulkLegacy && (
                <div className="mt-3">
                  <div className="text-xs font-semibold text-gray-600 mb-1">Replaced by (optional — pick one or more Full Titles)</div>
                  {replacementPicker(bulkReplacement, setBulkReplacement)}
                </div>
              )}
              <button
                onClick={handleSaveLegacy}
                disabled={busy}
                className="mt-3 px-3 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
              >
                Save legacy status
              </button>
            </>
          ) : (
            <p className="text-xs text-gray-500">Legacy status only applies to Certifications and Accreditations; none are present under this Full Title.</p>
          )}
        </div>

      </section>

      {/* Reporting and removal last: both take the Full Title out of
          circulation, and Delete removes completions with it. */}
      <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4 space-y-5">
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Reporting</label>
          <div className="flex items-center gap-3">
            <button
              onClick={handleBulkIgnored}
              disabled={busy || members.length === 0}
              className="px-3 py-2 text-sm bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 disabled:opacity-50"
            >
              {allIgnored ? "Restore this Full Title" : "Ignore this Full Title"}
            </button>
            <p className="text-xs text-gray-500">
              {allIgnored
                ? "Currently ignored — left out of the dashboard, every report and exports."
                : "Not needed? Ignoring leaves it out of the dashboard, every report and exports. Completions are kept and it can be restored."}
            </p>
          </div>
        </div>

        {/* Delete group */}
        <div className="border-t border-gray-100 pt-4">
          <button onClick={() => setShowDelete(true)} className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-red-50 text-red-700 rounded-lg hover:bg-red-100">
            <Trash2 size={14} /> Delete this Full Title ({meta?.memberCount ?? members.length} training titles)
          </button>
        </div>
      </section>

      {/* Members table */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">Mapped training titles</h2>
          <button onClick={() => { setNewTraining({ ...emptyEdit, trainingType: "Certification", function: "Sales", productType: productTypes[0] || "" }); setShowAdd(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <Plus size={14} /> Add training title
          </button>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Training Title</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Type</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Product</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Function</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Link</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Legacy</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((t) => {
                  const isEditing = editingTitle === t.trainingTitle;
                  const replFulls = t.isLegacy ? Array.from(new Set((t.replacedBy ?? []).map((rt) => titleToFull.get(rt) ?? rt))) : [];
                  return (
                    <tr key={t.trainingTitle} className="border-b border-gray-100 align-top hover:bg-gray-50">
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <input type="text" value={editValues.trainingTitle}
                            onChange={(e) => setEditValues((p) => ({ ...p, trainingTitle: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm w-full" />
                        ) : t.trainingTitle}
                      </td>
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <select value={editValues.trainingType}
                            onChange={(e) => { const val = e.target.value; setEditValues((p) => ({ ...p, trainingType: val, certification: (val === "InstructorLedTraining" || val === "OLX") ? p.certification : [], subItems: val === "OLX" ? p.subItems : [], parents: val === "OLXSubItem" ? p.parents : [], isLegacy: LEGACY_ELIGIBLE.includes(val) ? p.isLegacy : false })); }}
                            className="border border-gray-300 rounded px-2 py-1 text-sm">
                            {TRAINING_TYPES.map((tt) => <option key={tt} value={tt}>{TRAINING_TYPE_LABELS[tt]}</option>)}
                          </select>
                        ) : (TRAINING_TYPE_LABELS[t.trainingType] || t.trainingType)}
                      </td>
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <select value={editValues.productType} onChange={(e) => setEditValues((p) => ({ ...p, productType: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm">
                            {productTypes.map((pt) => <option key={pt} value={pt}>{pt}</option>)}
                          </select>
                        ) : t.productType}
                      </td>
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <select value={editValues.function} onChange={(e) => setEditValues((p) => ({ ...p, function: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm">
                            {FUNCTION_TYPES.map((ft) => <option key={ft} value={ft}>{FUNCTION_TYPE_LABELS[ft]}</option>)}
                          </select>
                        ) : (FUNCTION_TYPE_LABELS[t.function] || t.function)}
                      </td>
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <input type="url" value={editValues.link} onChange={(e) => setEditValues((p) => ({ ...p, link: e.target.value }))}
                            className="border border-gray-300 rounded px-2 py-1 text-sm w-full" placeholder="https://…" />
                        ) : safeExternalUrl(t.link) ? <a href={safeExternalUrl(t.link) ?? undefined} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Link</a> : "-"}
                      </td>
                      <td className="px-4 py-3">
                        {t.isLegacy ? (
                          <div>
                            <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">Legacy</span>
                            {replFulls.length > 0 ? (
                              <div className="text-xs text-gray-500 mt-1 inline-flex items-center gap-1"><ArrowRight size={12} /> {replFulls.join(", ")}</div>
                            ) : (
                              <div className="text-xs italic text-orange-700 mt-1">No replacement</div>
                            )}
                          </div>
                        ) : <span className="text-gray-300">-</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          {isEditing ? (
                            <>
                              <button onClick={() => handleSaveMember(t.trainingTitle)} className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"><Save size={14} /></button>
                              <button onClick={() => setEditingTitle(null)} className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Cancel</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => beginEdit(t)} className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Edit</button>
                              <button onClick={() => handleDeleteMember(t.trainingTitle)} className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"><Trash2 size={14} /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {/* Expanded editors for the row being edited. "Leads to
                    Certification(s)" is no longer among them: it is a property of
                    the training, not of the spelling it was imported under, so it
                    is set once in the section above rather than once per row. */}
                {editingTitle && LEGACY_ELIGIBLE.includes(editValues.trainingType) && (
                  <tr className="bg-blue-50/40 border-b border-gray-100">
                    <td colSpan={7} className="px-4 py-3">
                      <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-gray-600">
                        <input type="checkbox" checked={editValues.isLegacy}
                          onChange={(e) => setEditValues((p) => ({ ...p, isLegacy: e.target.checked, replacedByFulls: e.target.checked ? p.replacedByFulls : [] }))}
                          className="rounded border-gray-300" />
                        Mark as Legacy
                      </label>
                      {editValues.isLegacy && (
                        <div className="mt-2 max-w-md">
                          <div className="text-xs font-semibold text-gray-600 mb-1">Replaced by (pick Full Titles)</div>
                          {replacementPicker(editValues.replacedByFulls, (next) =>
                            setEditValues((p) => ({ ...p, replacedByFulls: next }))
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                {editingTitle && (editValues.trainingType === "OLX" || editValues.trainingType === "OLXSubItem") && (
                  <tr className="bg-blue-50/40 border-b border-gray-100">
                    <td colSpan={7} className="px-4 py-3">
                      {editValues.trainingType === "OLX" ? (
                        <div className="max-w-md">
                          <div className="text-xs font-semibold text-gray-600 mb-1">Sub-Items (none = single-item OLX)</div>
                          <div className="max-h-40 overflow-y-auto border border-gray-200 rounded px-2 py-1 text-sm space-y-1 bg-white">
                            {subItemOptions.length === 0 ? <span className="text-gray-400 text-xs">No OLX Sub-Item entries available.</span> : subItemOptions.map((s) => (
                              <label key={s.trainingTitle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                                <input type="checkbox" checked={editValues.subItems.includes(s.trainingTitle)}
                                  onChange={(e) => setEditValues((p) => ({ ...p, subItems: e.target.checked ? [...p.subItems, s.trainingTitle] : p.subItems.filter((x) => x !== s.trainingTitle) }))}
                                  className="rounded border-gray-300" />
                                <span className="text-xs">{s.fullTitle}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="max-w-md">
                          <div className="text-xs font-semibold text-gray-600 mb-1">Parent OLX (sub-item can belong to many)</div>
                          <div className="max-h-40 overflow-y-auto border border-gray-200 rounded px-2 py-1 text-sm space-y-1 bg-white">
                            {parentOptions.length === 0 ? <span className="text-gray-400 text-xs">No OLX parent entries available.</span> : parentOptions.map((pa) => (
                              <label key={pa.trainingTitle} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 rounded px-1">
                                <input type="checkbox" checked={editValues.parents.includes(pa.trainingTitle)}
                                  onChange={(e) => setEditValues((p) => ({ ...p, parents: e.target.checked ? [...p.parents, pa.trainingTitle] : p.parents.filter((x) => x !== pa.trainingTitle) }))}
                                  className="rounded border-gray-300" />
                                <span className="text-xs">{pa.fullTitle}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Delete group confirm */}
      <Modal open={showDelete} onClose={() => setShowDelete(false)} title="Delete Full Title"
        actions={
          <>
            <button onClick={() => setShowDelete(false)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleDeleteGroup} disabled={busy} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50">Delete all</button>
          </>
        }>
        <div className="flex items-start gap-3 text-sm text-gray-700">
          <AlertTriangle size={20} className="text-red-500 shrink-0 mt-0.5" />
          <p>This permanently deletes all {meta?.memberCount ?? members.length} training titles mapped to <span className="font-semibold">{fullTitle}</span>. Completion records for these titles are also removed. This cannot be undone.</p>
        </div>
      </Modal>

      {/* Add training title modal */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title={`Add training title to "${fullTitle}"`} size="lg"
        actions={
          <>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300">Cancel</button>
            <button onClick={handleAddMember} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Add</button>
          </>
        }>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Training Title *</label>
            <input type="text" value={newTraining.trainingTitle} onChange={(e) => setNewTraining((p) => ({ ...p, trainingTitle: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Full Title</label>
            <input type="text" value={fullTitle} disabled className="w-full border border-gray-200 bg-gray-50 text-gray-500 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Training Type *</label>
            <select value={newTraining.trainingType}
              onChange={(e) => { const val = e.target.value; setNewTraining((p) => ({ ...p, trainingType: val, certification: (val === "InstructorLedTraining" || val === "OLX") ? p.certification : [], subItems: val === "OLX" ? p.subItems : [], parents: val === "OLXSubItem" ? p.parents : [] })); }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
              {TRAINING_TYPES.map((t) => <option key={t} value={t}>{TRAINING_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Product Type *</label>
            <select value={newTraining.productType} onChange={(e) => setNewTraining((p) => ({ ...p, productType: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
              {productTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Function *</label>
            <select value={newTraining.function} onChange={(e) => setNewTraining((p) => ({ ...p, function: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
              {FUNCTION_TYPES.map((t) => <option key={t} value={t}>{FUNCTION_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Link</label>
            <input type="url" value={newTraining.link} onChange={(e) => setNewTraining((p) => ({ ...p, link: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="https://…" />
          </div>
        </div>
      </Modal>
    </div>
  );
}
