"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import PageHeader from "@/components/layout/PageHeader";
import Modal from "@/components/ui/Modal";
import { TrainingDataRow } from "@/types";
import { Plus, Trash2, Save, AlertTriangle } from "lucide-react";
import FullTitlePicker, { type FullTitleOption } from "@/components/training/FullTitlePicker";
import { INPUT_CLASS, SELECT_CLASS } from "@/components/ui/FormControls";

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
/** How many program/offering requirements name this group's training titles. */
interface ReferenceCounts {
  programRequirements: number;
  offeringRequirements: number;
}

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
 * Two different exclusions, because two different questions are being asked:
 *
 * - `excludeFullTitle` drops a whole Full Title. Right for Merge and Move,
 *   which act on the Full Title as a unit — you cannot merge a group into
 *   itself whatever types it carries.
 * - `excludeGroups` drops a `(fullTitle, trainingType)` pair. Right for every
 *   relationship picker, because that pair is what a training actually IS. A
 *   Full Title may legitimately carry a Certification *and* the instructor-led
 *   training preparing for it, so dropping the whole Full Title hid the very
 *   target the admin wanted — and the server then dropped it on save too,
 *   silently, which is what made this worth separating rather than leaving as a
 *   quirk of the picker.
 */
function buildFullTitleOptions(
  rows: TrainingDataRow[],
  types: string[],
  opts: { excludeFullTitle?: string; excludeGroups?: { fullTitle: string; trainingType: string }[] } = {},
): FullTitleOption[] {
  const excludedPairs = new Set(
    (opts.excludeGroups ?? []).map((g) => `${g.fullTitle}::${g.trainingType}`),
  );
  const byFull = new Map<string, { types: Set<string>; count: number }>();
  for (const r of rows) {
    if (!types.includes(r.trainingType)) continue;
    if (opts.excludeFullTitle && r.fullTitle === opts.excludeFullTitle) continue;
    if (excludedPairs.has(`${r.fullTitle}::${r.trainingType}`)) continue;
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
  // The rest of the per-training fields, same shape and same reason: they
  // describe the training, not the spelling it was imported under.
  const [cardFields, setCardFields] = useState<Record<string, { productType: string; function: string; link: string }>>({});
  const [olxLinks, setOlxLinks] = useState<Record<string, string[]>>({});
  const [references, setReferences] = useState<ReferenceCounts | null>(null);
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
  // Move / merge / delete-an-alias, each behind a confirm because each one
  // changes what the reports count or removes completion records.
  const [mergeTarget, setMergeTarget] = useState<string[]>([]);
  const [showMerge, setShowMerge] = useState(false);
  const [movingTitle, setMovingTitle] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<string[]>([]);
  const [moveNewFullTitle, setMoveNewFullTitle] = useState("");
  const [deletingTitle, setDeletingTitle] = useState<string | null>(null);

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
    () =>
      buildFullTitleOptions(allRows, LEGACY_ELIGIBLE, {
        excludeGroups: LEGACY_ELIGIBLE.map((trainingType) => ({ fullTitle, trainingType })),
      }),
    [allRows, fullTitle]
  );

  /** Every other Full Title — the destinations for a merge or a move. */
  const allFullTitleOptions = useMemo<FullTitleOption[]>(
    () => buildFullTitleOptions(allRows, TRAINING_TYPES, { excludeFullTitle: fullTitle }),
    [allRows, fullTitle]
  );

  /** OLX sub-items / OLX parents, for the membership pickers. */
  const subItemOptionsByType = useMemo<Record<string, FullTitleOption[]>>(
    () => ({
      OLX: buildFullTitleOptions(allRows, ["OLXSubItem"], {
        excludeGroups: [{ fullTitle, trainingType: "OLX" }],
      }),
      OLXSubItem: buildFullTitleOptions(allRows, ["OLX"], {
        excludeGroups: [{ fullTitle, trainingType: "OLXSubItem" }],
      }),
    }),
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
    () =>
      buildFullTitleOptions(allRows, ["Certification"], {
        excludeGroups: CERT_BEARING.map((trainingType) => ({ fullTitle, trainingType })),
      }),
    [allRows, fullTitle]
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
          setReferences(group.references ?? null);
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
    const fields: Record<string, { productType: string; function: string; link: string }> = {};
    for (const g of groups) {
      next[g.trainingType] = g.certificationFullTitles;
      fields[g.trainingType] = {
        productType: g.productType,
        function: g.function,
        link: g.link ?? "",
      };
    }
    setLeadsTo(next);
    setCardFields(fields);
  }

  // OLX membership is seeded from the members rather than the groups block: it
  // lives in a join table, not on the row, so the server returns it per member.
  const [prevOlxMembers, setPrevOlxMembers] = useState(members);
  if (prevOlxMembers !== members) {
    setPrevOlxMembers(members);
    const next: Record<string, string[]> = {};
    for (const m of members) {
      const related = m.trainingType === "OLX" ? m.subItems : m.trainingType === "OLXSubItem" ? m.parents : [];
      const fulls = (related ?? []).map((t) => titleToFull.get(t) ?? t);
      next[m.trainingType] = Array.from(new Set([...(next[m.trainingType] ?? []), ...fulls]));
    }
    setOlxLinks(next);
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

  // Deleting one training title cascades its completion records, exactly as
  // deleting the whole group does — so it gets the same confirmation, which it
  // never had.
  const handleDeleteMemberConfirmed = async () => {
    if (!deletingTitle) return;
    setBusy(true);
    const res = await fetch(`/api/training-data/${encodeURIComponent(deletingTitle)}`, { method: "DELETE" });
    setBusy(false);
    setDeletingTitle(null);
    if (!res.ok) {
      setError("Delete failed");
      return;
    }
    if (members.length <= 1) router.push("/admin/training-data");
    else fetchAll();
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

  /** Product / Function / Link for one training, in one call. */
  const handleSaveCardFields = async (trainingType: string) => {
    const f = cardFields[trainingType];
    if (!f) return;
    const ok = await patchGroup({
      scope: { trainingType },
      setProductType: f.productType,
      setFunction: f.function,
      setLink: f.link.trim() === "" ? null : f.link.trim(),
    });
    if (ok) fetchAll();
  };

  /**
   * OLX membership, set once for the training. Safe to key on Full Titles only
   * because the completion rule now counts a parent's sub-items per Full Title
   * — under the old per-title rule this would have made the parent completable
   * only by someone who had taken every spelling of every sub-item.
   */
  const handleSaveOlx = async (trainingType: string) => {
    const value = olxLinks[trainingType] ?? [];
    const ok = await patchGroup({
      scope: { trainingType },
      ...(trainingType === "OLX"
        ? { setSubItemFullTitles: value }
        : { setParentFullTitles: value }),
    });
    if (ok) fetchAll();
  };

  const handleMerge = async () => {
    const target = mergeTarget[0];
    if (!target) return;
    const ok = await patchGroup({ mergeInto: target });
    if (ok) {
      setShowMerge(false);
      router.replace(`/admin/training-data/${encodeURIComponent(target)}`);
    }
  };

  const handleMove = async () => {
    if (!movingTitle) return;
    const target = moveNewFullTitle.trim() || moveTarget[0];
    if (!target) return;
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/training-data/full-title/${encodeURIComponent(fullTitle)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moveAliases: { trainingTitles: [movingTitle], toFullTitle: target } }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Move failed");
      return;
    }
    const data = await res.json();
    setMovingTitle(null);
    setMoveTarget([]);
    setMoveNewFullTitle("");
    // Moving the last training title empties the group, so there is nothing
    // left to re-fetch — the GET would 404 and strand the user on the
    // not-found panel.
    if (data.remainingMemberCount === 0) router.push("/admin/training-data");
    else fetchAll();
  };

  /**
   * Type is the one field still edited per training title, because it is what
   * decides which training an alias belongs to: changing it moves that alias to
   * another card rather than re-typing the whole group. It is also the most
   * destructive field — leaving OLX detaches sub-items, becoming an OLX
   * sub-item clears "leads to", and leaving Cert/Accred clears the legacy pair.
   */
  const handleChangeType = async (trainingTitle: string, nextType: string) => {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/training-data/${encodeURIComponent(trainingTitle)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trainingType: nextType }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Could not change the type");
      return;
    }
    fetchAll();
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

  /** Fields the members disagree on — what a merge would flatten. */
  const divergentFields = useMemo(() => {
    const names = new Set<string>();
    for (const g of groups) {
      if (g.productTypeVaries) names.add("product");
      if (g.functionVaries) names.add("function");
      if (g.linkVaries) names.add("link");
      if (g.certificationVaries) names.add("leads to");
    }
    return Array.from(names);
  }, [groups]);

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

        {/* Merge. Renaming onto an existing Full Title used to do this silently
            and with no way back; the rename now refuses that collision, so this
            is the only way to combine two groups and it says what it will do. */}
        <div className="border-t border-gray-100 pt-4">
          <label className="block text-xs font-semibold text-gray-600 mb-1">Merge into another Full Title</label>
          <p className="text-xs text-gray-500 mb-2">
            Moves all {meta?.memberCount ?? members.length} training title
            {(meta?.memberCount ?? members.length) === 1 ? "" : "s"}{" "}
            into the Full Title you pick. This one then no longer exists.
          </p>
          <FullTitlePicker
            options={allFullTitleOptions}
            value={mergeTarget}
            onChange={setMergeTarget}
            multiple={false}
            searchPlaceholder="Search Full Titles…"
            emptyMessage="No other Full Titles to merge into."
          />
          <button
            onClick={() => setShowMerge(true)}
            disabled={busy || mergeTarget.length === 0}
            className="mt-3 px-3 py-2 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50"
          >
            Merge…
          </button>
        </div>

        {/* Bulk product / function — only worth offering when the Full Title
            covers more than one training. With a single card these are the same
            two controls as the card's own, and showing both invites the reader
            to wonder which one wins. */}
        {groups.length > 1 && (
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
        )}

      </section>

      {/* One card per training. A Full Title can legitimately cover more than
          one training type — a Certification and the Instructor-Led Training
          that prepares for it are two trainings sharing a display name, and the
          rest of the app counts them separately — so this is grouped by type
          rather than flattened into one form. Everything here describes the
          TRAINING, not the spelling it was imported under, which is why none of
          it is edited per training title any more. */}
      {groups.map((g) => {
        const f = cardFields[g.trainingType] ?? { productType: "", function: "", link: "" };
        const setField = (key: "productType" | "function" | "link", value: string) =>
          setCardFields((prev) => ({ ...prev, [g.trainingType]: { ...f, [key]: value } }));
        const varies = [
          g.productTypeVaries && "product",
          g.functionVaries && "function",
          g.linkVaries && "link",
        ].filter((v): v is string => typeof v === "string");
        return (
          <section key={g.trainingType} className="mb-6 bg-white rounded-lg border border-gray-200 p-4 space-y-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-700">
                {TRAINING_TYPE_LABELS[g.trainingType] || g.trainingType}
              </h2>
              <span className="text-xs text-gray-500">
                {g.memberCount} training title{g.memberCount === 1 ? "" : "s"}
              </span>
            </div>

            {varies.length > 0 && (
              <p className="text-xs text-orange-600">
                These training titles currently disagree on{" "}
                {varies.join(", ")}. Saving applies one answer to all of them.
              </p>
            )}

            {/* Properties */}
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Product</label>
                <select value={f.productType} onChange={(e) => setField("productType", e.target.value)} className={SELECT_CLASS}>
                  {productTypes.map((pt) => <option key={pt} value={pt}>{pt}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Function</label>
                <select value={f.function} onChange={(e) => setField("function", e.target.value)} className={SELECT_CLASS}>
                  {FUNCTION_TYPES.map((ft) => <option key={ft} value={ft}>{FUNCTION_TYPE_LABELS[ft]}</option>)}
                </select>
              </div>
              <div className="flex-1 min-w-[220px]">
                <label className="block text-xs font-semibold text-gray-600 mb-1">Link</label>
                <input
                  type="url"
                  value={f.link}
                  onChange={(e) => setField("link", e.target.value)}
                  placeholder="https://…"
                  className={`${INPUT_CLASS} w-full`}
                />
              </div>
              <button
                onClick={() => handleSaveCardFields(g.trainingType)}
                disabled={busy}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                Save
              </button>
            </div>

            {/* Leads to Certification(s) — only ILT and OLX can lead anywhere. */}
            {CERT_BEARING.includes(g.trainingType) && (
              <div className="border-t border-gray-100 pt-4">
                <div className="text-xs font-semibold text-gray-600 mb-1">Leads to Certification(s)</div>
                <p className="text-xs text-gray-500 mb-2">
                  The certification(s) this training prepares people for. It is
                  recommended preparation &mdash; taking the training does not
                  itself grant the certification.
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
                  onChange={(next) => setLeadsTo((prev) => ({ ...prev, [g.trainingType]: next }))}
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
            )}

            {/* OLX membership. Pickable by Full Title only because the
                completion rule now counts a parent's sub-items per Full Title. */}
            {(g.trainingType === "OLX" || g.trainingType === "OLXSubItem") && (
              <div className="border-t border-gray-100 pt-4">
                <div className="text-xs font-semibold text-gray-600 mb-1">
                  {g.trainingType === "OLX" ? "Sub-items" : "Belongs to OLX"}
                </div>
                <p className="text-xs text-gray-500 mb-2">
                  {g.trainingType === "OLX"
                    ? "This OLX is complete once a learner has finished every sub-item. Leave it empty for a single-item OLX."
                    : "The parent OLX(es) this sub-item counts towards."}
                </p>
                <FullTitlePicker
                  options={subItemOptionsByType[g.trainingType] ?? []}
                  value={olxLinks[g.trainingType] ?? []}
                  onChange={(next) => setOlxLinks((prev) => ({ ...prev, [g.trainingType]: next }))}
                  searchPlaceholder={g.trainingType === "OLX" ? "Search sub-items…" : "Search OLX trainings…"}
                  emptyMessage={
                    g.trainingType === "OLX"
                      ? "No OLX sub-items exist yet. Set a training's type to OLX Sub-Item first."
                      : "No OLX trainings available."
                  }
                />
                <button
                  onClick={() => handleSaveOlx(g.trainingType)}
                  disabled={busy}
                  className="mt-3 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            )}
          </section>
        );
      })}

      {/* Legacy is its own card rather than a field on a training card,
          because it genuinely spans them: the cascade applies to every
          Certification and Accreditation under this Full Title, which can be
          more than one card. Hidden outright when none is present — a card
          whose only content is "this does not apply here" would be noise on
          every OLX and ILT page in the catalogue. */}
      {hasEligible && (
        <section className="mb-6 bg-white rounded-lg border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Legacy</h2>
          <div>
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
          </div>
        </section>
      )}

      {/* The training titles themselves. Everything that describes the
          TRAINING now lives in the cards above, so this is only about the
          aliases: the spellings this training arrived under. What is left is
          genuinely per-alias — its name, which training it belongs to, and
          whether it should exist at all. */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Training titles</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              The different names this training has been imported under. They all
              mean the same training, and are counted as one.
            </p>
          </div>
          <button onClick={() => { setNewTraining({ ...emptyEdit, trainingType: groups[0]?.trainingType || "Certification", function: "Sales", productType: productTypes[0] || "" }); setShowAdd(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            <Plus size={14} /> Add training title
          </button>
        </div>

        {references && (references.programRequirements > 0 || references.offeringRequirements > 0) && (
          <p className="text-xs text-gray-500 mb-2">
            {references.programRequirements > 0 && (
              <>{references.programRequirements} program requirement{references.programRequirements === 1 ? "" : "s"}</>
            )}
            {references.programRequirements > 0 && references.offeringRequirements > 0 ? " and " : ""}
            {references.offeringRequirements > 0 && (
              <>{references.offeringRequirements} offering requirement{references.offeringRequirements === 1 ? "" : "s"}</>
            )}
            {" "}reference these training titles. Moving one changes which
            learners those requirements count.
          </p>
        )}

        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Training Title</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Counts as</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map((t) => {
                  const isEditing = editingTitle === t.trainingTitle;
                  return (
                    <tr key={t.trainingTitle} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        {isEditing ? (
                          <input type="text" value={editValues.trainingTitle}
                            onChange={(e) => setEditValues((p) => ({ ...p, trainingTitle: e.target.value }))}
                            className={`${INPUT_CLASS} w-full`} />
                        ) : t.trainingTitle}
                      </td>
                      <td className="px-4 py-3">
                        {/* Type is the one field still edited per alias: it is
                            what decides which training the alias belongs to, so
                            changing it moves this row to another card rather
                            than re-typing the whole group. */}
                        <select
                          value={t.trainingType}
                          onChange={(e) => handleChangeType(t.trainingTitle, e.target.value)}
                          disabled={busy || isEditing}
                          className={SELECT_CLASS}
                        >
                          {TRAINING_TYPES.map((tt) => <option key={tt} value={tt}>{TRAINING_TYPE_LABELS[tt]}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          {isEditing ? (
                            <>
                              <button onClick={() => handleSaveMember(t.trainingTitle)} className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"><Save size={14} /></button>
                              <button onClick={() => setEditingTitle(null)} className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200">Cancel</button>
                            </>
                          ) : (
                            <>
                              <button onClick={() => beginEdit(t)} className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Rename</button>
                              <button
                                onClick={() => { setMovingTitle(t.trainingTitle); setMoveTarget([]); setMoveNewFullTitle(""); }}
                                className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                              >
                                Move to&hellip;
                              </button>
                              <button onClick={() => setDeletingTitle(t.trainingTitle)} className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"><Trash2 size={14} /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {members.length === 0 && (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400 text-sm">No training titles.</td></tr>
                )}
              </tbody>
            </table>
          </div>
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

      {/* Merge confirm. The divergence list is the point of it: after a merge
          the card shows one value per field and the next save flattens the
          rest, which is the one genuinely lossy part of editing by group. */}
      {showMerge && mergeTarget[0] && (
        <Modal open onClose={() => setShowMerge(false)} title="Merge Full Titles">
          <div className="space-y-3 text-sm">
            <p>
              Move all {meta?.memberCount ?? members.length} training title
              {(meta?.memberCount ?? members.length) === 1 ? "" : "s"}{" "}
              from <strong>{fullTitle}</strong>{" "}into{" "}
              <strong>{mergeTarget[0]}</strong>?
            </p>
            <p className="text-xs text-gray-600">
              <strong>{fullTitle}</strong>{" "}will no longer exist. Completion
              records are not touched &mdash; but from now on they are counted
              under <strong>{mergeTarget[0]}</strong>, and reports that listed
              the two separately will show one training.
            </p>
            {divergentFields.length > 0 && (
              <p className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                These training titles disagree on {divergentFields.join(", ")}.
                After the merge the card shows one value and the next save
                applies it to all of them.
              </p>
            )}
            {references && (references.programRequirements > 0 || references.offeringRequirements > 0) && (
              <p className="text-xs text-gray-600">
                {references.programRequirements + references.offeringRequirements}{" "}
                program/offering requirement
                {references.programRequirements + references.offeringRequirements === 1 ? "" : "s"}{" "}
                reference these training titles; which learners they count will change.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowMerge(false)} className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">Cancel</button>
              <button onClick={handleMerge} disabled={busy} className="px-3 py-2 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800 disabled:opacity-50">Merge</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Move one training title to another Full Title. */}
      {movingTitle && (
        <Modal open onClose={() => setMovingTitle(null)} title="Move training title">
          <div className="space-y-3 text-sm">
            <p>
              Move <strong>{movingTitle}</strong>{" "}out of{" "}
              <strong>{fullTitle}</strong>.
            </p>
            <p className="text-xs text-gray-600">
              Completion records are not touched. What changes is which training
              they are counted under.
            </p>
            {members.length === 1 && (
              <p className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                This is the last training title under{" "}
                <strong>{fullTitle}</strong>, so that Full Title will no longer
                exist.
              </p>
            )}
            <div>
              <div className="text-xs font-semibold text-gray-600 mb-1">Move into an existing Full Title</div>
              <FullTitlePicker
                options={allFullTitleOptions}
                value={moveTarget}
                onChange={(next) => { setMoveTarget(next); setMoveNewFullTitle(""); }}
                multiple={false}
                searchPlaceholder="Search Full Titles…"
                emptyMessage="No other Full Titles exist yet."
              />
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-600 mb-1">&hellip;or type a new one</div>
              <input
                type="text"
                value={moveNewFullTitle}
                onChange={(e) => { setMoveNewFullTitle(e.target.value); if (e.target.value) setMoveTarget([]); }}
                placeholder="New Full Title"
                className={`${INPUT_CLASS} w-full max-w-md`}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setMovingTitle(null)} className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">Cancel</button>
              <button
                onClick={handleMove}
                disabled={busy || (!moveNewFullTitle.trim() && moveTarget.length === 0)}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                Move
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Deleting one training title cascades its completion records, exactly
          as deleting the whole group does — so it gets the same warning, which
          it never had. */}
      {deletingTitle && (
        <Modal open onClose={() => setDeletingTitle(null)} title="Delete training title">
          <div className="space-y-3 text-sm">
            <p className="flex items-start gap-2">
              <AlertTriangle size={18} className="text-red-600 mt-0.5 shrink-0" />
              <span>
                Delete <strong>{deletingTitle}</strong>? This also deletes every
                completion record filed under that name. It cannot be undone.
              </span>
            </p>
            {members.length === 1 && (
              <p className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                It is the last training title under{" "}
                <strong>{fullTitle}</strong>, so that Full Title will no longer
                exist either.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setDeletingTitle(null)} className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">Cancel</button>
              <button onClick={handleDeleteMemberConfirmed} disabled={busy} className="px-3 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50">Delete</button>
            </div>
          </div>
        </Modal>
      )}

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
