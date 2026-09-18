import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { TrainingType } from "@prisma/client";
import { handleAuthError, requireAuth, requireSuperAdmin } from "@/lib/auth";
import { recomputeAllStudentsForParent, syncMemberships } from "@/lib/olx";
import { isRejectedLink, safeDecodeParam, safeExternalUrl } from "@/lib/utils";
import { resolveProductTypeId } from "@/lib/product-types";
import { sanitizeLegacyFields } from "@/lib/legacy-training";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";
import {
  CERT_BEARING_TYPES,
  countTitleReferences,
  dedupeTitles,
  expandFullTitles,
  isFunctionType,
  isTrainingType,
  rewriteTitleReferences,
} from "@/lib/training-group";

const LEGACY_ELIGIBLE_TYPES = ["Certification", "Accreditation"];

/**
 * GET — all TrainingData rows that share `fullTitle`, plus aggregate metadata.
 * Drives the Full Title detail page (`/admin/training-data/[fullTitle]`).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fullTitle: string }> }
) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { fullTitle } = await params;
  const decoded = safeDecodeParam(fullTitle);
  if (decoded === null) {
    return NextResponse.json({ error: "Invalid fullTitle parameter" }, { status: 400 });
  }

  const rows = await prisma.trainingData.findMany({
    where: { fullTitle: decoded },
    orderBy: { trainingTitle: "asc" },
    include: {
      productType: { select: { name: true } },
      subItemMemberships: { select: { subItemTrainingTitle: true } },
      parentMemberships: { select: { parentTrainingTitle: true } },
    },
  });

  if (rows.length === 0) {
    return NextResponse.json({ error: "Full Title not found" }, { status: 404 });
  }

  const members = rows.map((t) => ({
    trainingTitle: t.trainingTitle,
    fullTitle: t.fullTitle,
    trainingType: t.trainingType,
    productType: t.productType.name,
    function: t.function,
    link: t.link,
    certification: t.certification,
    isLegacy: t.isLegacy,
    replacedBy: t.replacedBy,
    isIncomplete: t.isIncomplete,
    isIgnored: t.isIgnored,
    subItems: t.subItemMemberships.map((m) => m.subItemTrainingTitle),
    parents: t.parentMemberships.map((m) => m.parentTrainingTitle),
  }));

  const meta = {
    types: Array.from(new Set(members.map((m) => m.trainingType))),
    products: Array.from(new Set(members.map((m) => m.productType))),
    functions: Array.from(new Set(members.map((m) => m.function))),
    memberCount: members.length,
    legacyEligibleCount: members.filter((m) => LEGACY_ELIGIBLE_TYPES.includes(m.trainingType)).length,
  };

  // One entry per (fullTitle, trainingType) pair — the unit every consumer
  // actually counts on (see `resolveSiblingTitles` in lib/program-compliance.ts).
  // The UI edits these, not individual training titles: a `trainingTitle` is
  // just the spelling a training arrived under in an import.
  //
  // `*Varies` flags exist because the members CAN disagree — nothing stopped
  // them before this was group-edited — and a form that silently showed one
  // member's value would flatten the others on the next save without saying so.
  const referenced = Array.from(
    new Set(members.flatMap((m) => [...m.certification, ...m.replacedBy])),
  );
  const referencedFulls = referenced.length
    ? await prisma.trainingData.findMany({
        where: { trainingTitle: { in: referenced } },
        select: { trainingTitle: true, fullTitle: true },
      })
    : [];
  // A dangling reference renders as its raw key rather than vanishing — the
  // same `?? title` fallback the UI has always used.
  const fullOf = new Map(referencedFulls.map((r) => [r.trainingTitle, r.fullTitle]));
  const toFulls = (titles: string[]) =>
    Array.from(new Set(titles.map((t) => fullOf.get(t) ?? t))).sort((a, b) => a.localeCompare(b));

  const byType = new Map<string, typeof members>();
  for (const m of members) {
    byType.set(m.trainingType, [...(byType.get(m.trainingType) ?? []), m]);
  }

  const groups = Array.from(byType.entries()).map(([trainingType, rows]) => {
    const distinct = <T,>(values: T[]) => Array.from(new Set(values));
    const legacyCount = rows.filter((r) => r.isLegacy).length;
    return {
      trainingType,
      trainingTitles: rows.map((r) => r.trainingTitle),
      memberCount: rows.length,
      productType: rows[0].productType,
      productTypeVaries: distinct(rows.map((r) => r.productType)).length > 1,
      function: rows[0].function,
      functionVaries: distinct(rows.map((r) => r.function)).length > 1,
      link: rows[0].link,
      linkVaries: distinct(rows.map((r) => r.link ?? "")).length > 1,
      // Tri-state. The bulk control used to seed from `.every()` while the list
      // page badged from `.some()`, so a partly-legacy group read as "not
      // legacy" and saving silently cleared the members that were.
      legacyState: legacyCount === 0 ? "none" : legacyCount === rows.length ? "all" : "some",
      certificationFullTitles: toFulls(rows.flatMap((r) => r.certification)),
      certificationVaries:
        distinct(rows.map((r) => [...r.certification].sort().join("\u0000"))).length > 1,
      replacedByFullTitles: toFulls(rows.flatMap((r) => r.replacedBy)),
    };
  });

  // What a move or a merge would disturb. Requirements name ONE representative
  // training title and expand it to its group at counting time, so regrouping
  // changes which holders they count — silently, and in both directions.
  const references = await countTitleReferences(members.map((m) => m.trainingTitle));

  return NextResponse.json({ fullTitle: decoded, members, meta, groups, references });
}
/**
 * PATCH — group operations across the TrainingData rows sharing `fullTitle`.
 *
 * A `trainingTitle` is the spelling a training arrived under in an import; the
 * thing being managed is the Full Title. So these verbs are the primary way the
 * catalogue is edited, and the per-row PUT is for the alias itself.
 *
 * `scope: { trainingType }` narrows the operation to one
 * `(fullTitle, trainingType)` pair — the unit every consumer counts on. Field
 * verbs REQUIRE it: a Full Title may legitimately carry a Certification and the
 * Instructor-Led Training that prepares for it, and those are two trainings, so
 * an unscoped field write would be ambiguous. Group-identity verbs (`rename`,
 * `setIgnored`) deliberately stay unscoped — they name the whole Full Title.
 *
 * Every key is tri-state: absent means "leave alone", so the UI can save one
 * section without touching the others. `setIgnored: false` and `setLink: null`
 * are meaningful values, which is why they are tested with `typeof`/`in` rather
 * than truthiness.
 *
 * Body keys (all optional; applied in this order):
 *  - rename: string                      → set a new fullTitle on every member
 *  - legacy: { isLegacy, replacedByFullTitles? }
 *      → for each Certification/Accreditation member, set isLegacy and expand
 *        the chosen replacement Full Titles to their underlying training titles.
 *  - setProductType: string              → apply a product type
 *  - setFunction: string                 → apply a function
 *  - setLink: string | null              → apply (or clear) a link
 *  - setCertificationFullTitles: string[] → the "leads to Certification(s)"
 *      relationship, set ONCE for the pair instead of once per training title.
 *      Expanded server-side to the chosen Full Titles' Certification members.
 *  - setSubItemFullTitles: string[]      → OLX membership, parent side
 *  - setParentFullTitles: string[]       → OLX membership, sub-item side
 *  - mergeInto: string                   → move every member into an EXISTING
 *      Full Title. Explicit because renaming onto an existing name used to do
 *      this silently and irreversibly; `rename` now refuses that collision.
 *  - moveAliases: { trainingTitles[], toFullTitle } → move some members out
 *  - setIgnored: boolean                 → mark/unmark the whole group as not needed
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ fullTitle: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { fullTitle } = await params;
  const decoded = safeDecodeParam(fullTitle);
  if (decoded === null) {
    return NextResponse.json({ error: "Invalid fullTitle parameter" }, { status: 400 });
  }

  // A single key here can fan out to every member of the group, so the body goes
  // through the shared reader (content-type, size cap, 400-on-malformed) rather
  // than a bare request.json(), which surfaced malformed input as a 500.
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // ---- Scope ----------------------------------------------------------------
  let scopeType: TrainingType | undefined;
  if (body.scope && typeof body.scope === "object") {
    if (body.scope.trainingType !== undefined) {
      if (!isTrainingType(body.scope.trainingType)) {
        return NextResponse.json({ error: "Invalid training type" }, { status: 400 });
      }
      scopeType = body.scope.trainingType;
    }
  }

  const FIELD_KEYS = [
    "setProductType",
    "setFunction",
    "setLink",
    "setCertificationFullTitles",
    "setSubItemFullTitles",
    "setParentFullTitles",
  ] as const;
  const touchesFields = FIELD_KEYS.some((k) => k in body && body[k] !== undefined);

  const allMembers = await prisma.trainingData.findMany({
    where: { fullTitle: decoded },
    select: { trainingTitle: true, trainingType: true },
  });
  if (allMembers.length === 0) {
    return NextResponse.json({ error: "Full Title not found" }, { status: 404 });
  }

  const distinctTypes = new Set(allMembers.map((m) => m.trainingType));
  // Only demand a scope where it is genuinely ambiguous. A single-type group —
  // which is nearly all of them — would otherwise have to send a scope it cannot
  // get wrong, and every existing caller would break.
  if (touchesFields && scopeType === undefined && distinctTypes.size > 1) {
    return NextResponse.json(
      {
        error:
          "This Full Title covers more than one training type. Say which one to change.",
        trainingTypes: Array.from(distinctTypes),
      },
      { status: 400 }
    );
  }

  const members = scopeType
    ? allMembers.filter((m) => m.trainingType === scopeType)
    : allMembers;
  if (members.length === 0) {
    return NextResponse.json({ error: "No training titles match that scope" }, { status: 404 });
  }
  const memberTitles = members.map((m) => m.trainingTitle);

  // ---- Validate + resolve everything BEFORE opening the transaction ---------
  let productTypeId: number | undefined;
  if (typeof body.setProductType === "string" && body.setProductType.trim()) {
    const resolved = await resolveProductTypeId(body.setProductType);
    if (resolved === null) {
      return NextResponse.json(
        { error: `Unknown product type "${body.setProductType}"` },
        { status: 400 }
      );
    }
    productTypeId = resolved;
  }

  // Was cast straight to FunctionType with no check, so a typo reached Prisma and
  // came back as a 500. The per-row route has always validated and 400'd.
  if (body.setFunction !== undefined && !isFunctionType(body.setFunction)) {
    return NextResponse.json({ error: "Invalid function" }, { status: 400 });
  }

  const rename = typeof body.rename === "string" ? body.rename.trim() : undefined;
  if (rename !== undefined && rename.length === 0) {
    return NextResponse.json({ error: "Full Title cannot be empty" }, { status: 400 });
  }
  // Full Titles are not unique, so renaming onto an existing one used to merge
  // the two groups — silently, and with no way back, since afterwards nothing
  // records which members came from where. Merging is a real operation and now
  // has its own verb; rename refuses to be it by accident.
  if (rename !== undefined && rename !== decoded) {
    const collision = await prisma.trainingData.count({ where: { fullTitle: rename } });
    if (collision > 0) {
      return NextResponse.json(
        {
          error: `A Full Title named "${rename}" already exists. Use Merge if you meant to combine them.`,
          collision: true,
        },
        { status: 409 }
      );
    }
  }

  // ---- Merge / move -------------------------------------------------------
  // Both are a plain `fullTitle` update: `trainingTitle` is the primary key and
  // is untouched, so no foreign key is traversed and not one TrainingTaken row
  // is read or written. What changes is the (fullTitle, trainingType) grouping
  // key — which is what report dedupe, sibling expansion and compliance-plan's
  // certKey are all built on, hence the cache flush at the end.
  const mergeInto = typeof body.mergeInto === "string" ? body.mergeInto.trim() : undefined;
  if (mergeInto !== undefined) {
    if (mergeInto.length === 0 || mergeInto === decoded) {
      return NextResponse.json({ error: "Choose a different Full Title to merge into" }, { status: 400 });
    }
    const targetCount = await prisma.trainingData.count({ where: { fullTitle: mergeInto } });
    if (targetCount === 0) {
      return NextResponse.json({ error: "Target Full Title not found" }, { status: 404 });
    }
    const moved = await prisma.trainingData.updateMany({
      where: { fullTitle: decoded },
      data: { fullTitle: mergeInto },
    });
    invalidateReportCache();
    return NextResponse.json({
      success: true,
      fullTitle: mergeInto,
      merged: moved.count,
    });
  }

  if (body.moveAliases !== undefined) {
    const move = body.moveAliases;
    const toFullTitle = typeof move?.toFullTitle === "string" ? move.toFullTitle.trim() : "";
    const wanted = dedupeTitles(move?.trainingTitles);
    if (toFullTitle.length === 0 || wanted.length === 0) {
      return NextResponse.json({ error: "Choose a training title and a destination" }, { status: 400 });
    }
    if (toFullTitle === decoded) {
      return NextResponse.json({ error: "That is already this Full Title" }, { status: 400 });
    }
    // Every named title must belong to THIS group — the route is scoped to one
    // Full Title, so accepting a stray title would let it move somebody else's.
    const memberSet = new Set(allMembers.map((m) => m.trainingTitle));
    const stray = wanted.filter((t) => !memberSet.has(t));
    if (stray.length > 0) {
      return NextResponse.json(
        { error: "Those training titles are not under this Full Title" },
        { status: 400 }
      );
    }
    await prisma.trainingData.updateMany({
      where: { trainingTitle: { in: wanted } },
      data: { fullTitle: toFullTitle },
    });
    invalidateReportCache();
    return NextResponse.json({
      success: true,
      moved: wanted.length,
      remainingMemberCount: allMembers.length - wanted.length,
    });
  }

  let link: string | null | undefined;
  if ("setLink" in body && body.setLink !== undefined) {
    if (body.setLink === null || body.setLink === "") {
      link = null;
    } else if (typeof body.setLink !== "string" || isRejectedLink(body.setLink)) {
      return NextResponse.json(
        { error: "Link must be a http:// or https:// web address" },
        { status: 400 }
      );
    } else {
      link = safeExternalUrl(body.setLink) ?? null;
    }
  }

  // "Leads to Certification(s)" — the whole point of this change. The admin picks
  // Full Titles; expansion to the underlying Certification training titles
  // happens here, so the client never has to hold the catalogue to translate and
  // the server never trusts a raw key it was handed.
  let certificationTitles: string[] | undefined;
  if (body.setCertificationFullTitles !== undefined) {
    if (!Array.isArray(body.setCertificationFullTitles)) {
      return NextResponse.json({ error: "Invalid certification list" }, { status: 400 });
    }
    const scopedTypes = scopeType ? [scopeType] : Array.from(distinctTypes);
    if (!scopedTypes.some((t) => CERT_BEARING_TYPES.includes(t as TrainingType))) {
      return NextResponse.json(
        { error: "Only Instructor-Led Training and OLX can lead to a certification" },
        { status: 400 }
      );
    }
    certificationTitles = await expandFullTitles(body.setCertificationFullTitles, {
      types: ["Certification"],
      // A training cannot lead to itself. Nothing stopped that before.
      excludeFullTitles: [decoded],
    });
  }

  // OLX membership, set once for the training rather than once per spelling.
  //
  // This is only safe because `lib/olx.ts` now counts a parent's sub-items per
  // (fullTitle, trainingType) group. Under the old per-title rule, expanding a
  // chosen sub-item Full Title to all of its spellings would have made the
  // parent completable only by somebody who had taken every spelling — i.e.
  // nobody — and every affected learner's materialised parent completion would
  // have disappeared.
  let subItemTitles: string[] | undefined;
  if (body.setSubItemFullTitles !== undefined) {
    if (!Array.isArray(body.setSubItemFullTitles)) {
      return NextResponse.json({ error: "Invalid sub-item list" }, { status: 400 });
    }
    if (!members.every((m) => m.trainingType === "OLX")) {
      return NextResponse.json(
        { error: "Only an OLX can have sub-items" },
        { status: 400 }
      );
    }
    subItemTitles = await expandFullTitles(body.setSubItemFullTitles, {
      types: ["OLXSubItem"],
      excludeFullTitles: [decoded],
    });
  }

  let parentTitles: string[] | undefined;
  if (body.setParentFullTitles !== undefined) {
    if (!Array.isArray(body.setParentFullTitles)) {
      return NextResponse.json({ error: "Invalid parent list" }, { status: 400 });
    }
    if (!members.every((m) => m.trainingType === "OLXSubItem")) {
      return NextResponse.json(
        { error: "Only an OLX sub-item can belong to a parent OLX" },
        { status: 400 }
      );
    }
    parentTitles = await expandFullTitles(body.setParentFullTitles, {
      types: ["OLX"],
      excludeFullTitles: [decoded],
    });
  }

  // Expand replacement Full Titles → underlying training titles (validated later
  // by sanitizeLegacyFields, which keeps only existing Cert/Accred titles).
  let expandedReplacement: string[] | undefined;
  let isLegacyTarget: boolean | undefined;
  if (body.legacy && typeof body.legacy === "object") {
    isLegacyTarget = body.legacy.isLegacy === true;
    expandedReplacement = isLegacyTarget
      ? await expandFullTitles(body.legacy.replacedByFullTitles, {
          types: ["Certification", "Accreditation"],
        })
      : [];
  }

  const staleParents = new Set<string>();

  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    // Field-level bulk updates. `rename` and `setIgnored` name the whole Full
    // Title, so they always apply to every member; the rest honour the scope.
    const groupData: Record<string, unknown> = {};
    if (rename !== undefined) groupData.fullTitle = rename;
    // Explicit boolean check: `false` is a meaningful value here (restore),
    // which a truthiness test would drop.
    if (typeof body.setIgnored === "boolean") groupData.isIgnored = body.setIgnored;
    if (Object.keys(groupData).length > 0) {
      await tx.trainingData.updateMany({ where: { fullTitle: decoded }, data: groupData });
    }

    const scopedData: Record<string, unknown> = {};
    if (productTypeId !== undefined) scopedData.productTypeId = productTypeId;
    if (body.setFunction !== undefined) scopedData.function = body.setFunction;
    if (link !== undefined) scopedData.link = link;
    if (Object.keys(scopedData).length > 0) {
      await tx.trainingData.updateMany({
        where: { trainingTitle: { in: memberTitles } },
        data: scopedData,
      });
    }

    if (certificationTitles !== undefined) {
      // An OLX sub-item may never carry a certification, matching the per-row
      // routes. A mixed group is only reachable here when no scope was needed,
      // so filter by the member's own type rather than assuming the scope.
      const bearers = members
        .filter((m) => CERT_BEARING_TYPES.includes(m.trainingType))
        .map((m) => m.trainingTitle);
      if (bearers.length > 0) {
        await tx.trainingData.updateMany({
          where: { trainingTitle: { in: bearers } },
          data: { certification: certificationTitles },
        });
      }
    }

    if (subItemTitles !== undefined || parentTitles !== undefined) {
      for (const m of members) {
        const sync = await syncMemberships(
          tx,
          m.trainingTitle,
          m.trainingType,
          subItemTitles,
          parentTitles,
        );
        for (const parent of sync.affectedParents) staleParents.add(parent);
      }
    }

    // Legacy cascade — per eligible member, so sanitizeLegacyFields can drop the
    // member's own training title from its replacement list.
    if (isLegacyTarget !== undefined) {
      for (const m of members) {
        if (!LEGACY_ELIGIBLE_TYPES.includes(m.trainingType)) continue;
        const legacy = await sanitizeLegacyFields(
          m.trainingTitle,
          m.trainingType,
          isLegacyTarget,
          expandedReplacement,
        );
        await tx.trainingData.update({
          where: { trainingTitle: m.trainingTitle },
          data: { isLegacy: legacy.isLegacy, replacedBy: legacy.replacedBy },
        });
      }
    }
  });

  // Outside the transaction: this is O(students x sub-items) sequential queries
  // and is the only thing keeping materialised parent completions honest.
  for (const parent of staleParents) {
    await recomputeAllStudentsForParent(parent);
  }

  invalidateReportCache();
  return NextResponse.json({ success: true, fullTitle: rename ?? decoded });
}

/**
 * DELETE — remove every TrainingData row sharing `fullTitle`. Recomputes any OLX
 * parents that referenced a deleted sub-item.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ fullTitle: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { fullTitle } = await params;
  const decoded = safeDecodeParam(fullTitle);
  if (decoded === null) {
    return NextResponse.json({ error: "Invalid fullTitle parameter" }, { status: 400 });
  }

  const members = await prisma.trainingData.findMany({
    where: { fullTitle: decoded },
    select: { trainingTitle: true },
  });
  if (members.length === 0) {
    return NextResponse.json({ error: "Full Title not found" }, { status: 404 });
  }
  const memberTitles = members.map((m) => m.trainingTitle);

  // Parent OLX rows that referenced any of these as a sub-item need a recompute
  // after the cascade delete.
  const memberships = await prisma.olxSubItemRelation.findMany({
    where: { subItemTrainingTitle: { in: memberTitles } },
    select: { parentTrainingTitle: true },
  });
  const affectedParents = Array.from(
    new Set(
      memberships
        .map((m) => m.parentTrainingTitle)
        .filter((p) => !memberTitles.includes(p)),
    ),
  );

  // Same unit as the single-title delete: the cascade does not reach other rows'
  // `certification[]`/`replacedBy[]`, which hold these titles as plain strings.
  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    await tx.trainingData.deleteMany({ where: { fullTitle: decoded } });
    for (const t of memberTitles) {
      await rewriteTitleReferences(tx, t, null);
    }
  });

  for (const p of affectedParents) {
    await recomputeAllStudentsForParent(p);
  }

  invalidateReportCache();
  return NextResponse.json({ success: true });
}
