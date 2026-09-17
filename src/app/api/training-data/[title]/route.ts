import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { TrainingType, FunctionType } from "@prisma/client";
import { handleAuthError, requireAuth, requireSuperAdmin } from "@/lib/auth";
import { recomputeAllStudentsForParent, syncMemberships } from "@/lib/olx";
import { isRejectedLink, safeDecodeParam, safeExternalUrl } from "@/lib/utils";
import { resolveProductTypeId } from "@/lib/product-types";
import { sanitizeLegacyFields, isLegacyEligible } from "@/lib/legacy-training";
import { rewriteTitleReferences } from "@/lib/training-group";
import { invalidateReportCache } from "@/lib/report-cache";

const isTrainingType = (v: unknown): v is TrainingType =>
  typeof v === "string" && Object.values(TrainingType).includes(v as TrainingType);
const isFunctionType = (v: unknown): v is FunctionType =>
  typeof v === "string" && Object.values(FunctionType).includes(v as FunctionType);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ title: string }> }
) {
  // Every sibling method on this route guards; this one did not (Round 1
  // item 3: the guard is a per-handler obligation, not a one-time fix).
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { title } = await params;
  const decodedTitleMaybe = safeDecodeParam(title);
  if (decodedTitleMaybe === null) {
    return NextResponse.json({ error: "Invalid title parameter" }, { status: 400 });
  }
  const decodedTitle = decodedTitleMaybe;

  const training = await prisma.trainingData.findUnique({
    where: { trainingTitle: decodedTitle },
    include: {
      subItemMemberships: { select: { subItemTrainingTitle: true } },
      parentMemberships: { select: { parentTrainingTitle: true } },
    },
  });

  if (!training) {
    return NextResponse.json({ error: "Training not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...training,
    subItems: training.subItemMemberships.map((m) => m.subItemTrainingTitle),
    parents: training.parentMemberships.map((m) => m.parentTrainingTitle),
  });
}

function dedupeStrings(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return Array.from(new Set(arr.filter((x): x is string => typeof x === "string" && !!x.trim())));
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ title: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const { title } = await params;
  const decodedTitleMaybe = safeDecodeParam(title);
  if (decodedTitleMaybe === null) {
    return NextResponse.json({ error: "Invalid title parameter" }, { status: 400 });
  }
  const decodedTitle = decodedTitleMaybe;
  const body = await request.json();

  // Same scheme allowlist as the create path: this is where an existing row's
  // link is edited, and a stored `javascript:` value is a live sink at render.
  if (isRejectedLink(body.link)) {
    return NextResponse.json(
      { error: "Link must be a http:// or https:// web address" },
      { status: 400 }
    );
  }

  const newTitle = body.trainingTitle?.trim();
  const subItems = body.subItems !== undefined ? dedupeStrings(body.subItems) : undefined;
  const parents = body.parents !== undefined ? dedupeStrings(body.parents) : undefined;

  // Enum validation. These used to be blind casts, so a bad value surfaced as a
  // 500 from Prisma rather than a 400 — and the completion gate below has to be
  // able to trust them.
  if (body.trainingType !== undefined && body.trainingType !== "" &&
      !isTrainingType(body.trainingType)) {
    return NextResponse.json({ error: "Invalid training type" }, { status: 400 });
  }
  if (body.function !== undefined && body.function !== "" &&
      !isFunctionType(body.function)) {
    return NextResponse.json({ error: "Invalid function" }, { status: 400 });
  }

  // Completing an auto-created ("needs attention") row. Its stored
  // type/product/function are import placeholders that the admin never chose,
  // so clearing the flag is only legitimate once all three are actually
  // supplied. The update spreads below are truthiness-guarded, so without this
  // check an empty value would be silently dropped — keeping the placeholder
  // while still marking the row complete, which is the exact failure this
  // gate exists to prevent.
  const completing = body.isIncomplete === false;
  if (completing) {
    const missing = [
      !body.trainingType && "Type",
      !body.productType && "Product",
      !body.function && "Function",
    ].filter((m): m is string => typeof m === "string");
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Choose a value for ${missing.join(", ")} before completing this entry` },
        { status: 400 }
      );
    }
  }

  // Renaming the training title changes the PRIMARY KEY, which used to be done
  // as delete + recreate. That was broken in two directions, both reproduced
  // against a real Postgres before this was changed:
  //
  //  - It re-pointed `training_taken` to the new title BEFORE the row existed.
  //    The FKs are not DEFERRABLE, so renaming any training somebody had
  //    actually completed aborted the whole transaction on a foreign-key
  //    violation and surfaced as a 500.
  //  - `ProgramData`, `ProgramDataAlternative`, `OfferingData` and
  //    `OfferingDataAlternative` are all `onDelete: Cascade` and were never
  //    recreated, so renaming a training SILENTLY DELETED every program and
  //    offering requirement naming it. No error, nothing in the UI — the
  //    requirement simply vanished from the dashboard.
  //
  // Every one of the seven referencing foreign keys is `ON UPDATE CASCADE`, so
  // updating the key in place carries all of them atomically and none of the
  // hand-migration is needed. That closes the class rather than the instance:
  // a table added later inherits the behaviour instead of having to be
  // remembered here. It also removes the old path's "every flag not named here
  // is silently reset" hazard, since nothing is recreated from scratch.
  const renaming = Boolean(newTitle && newTitle !== decodedTitle);
  if (renaming) {
    const existing = await prisma.trainingData.findUnique({
      where: { trainingTitle: newTitle },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Training title "${newTitle}" already exists` },
        { status: 409 }
      );
    }
  }
  // The key everything below writes to. Reads before the transaction still use
  // `decodedTitle`, because the rename has not happened yet.
  const targetTitle: string = renaming ? newTitle : decodedTitle;

  let updateProductTypeId: number | undefined;
  if (body.productType !== undefined) {
    const resolved = await resolveProductTypeId(body.productType);
    if (resolved === null) {
      return NextResponse.json(
        { error: `Unknown product type "${body.productType}"` },
        { status: 400 }
      );
    }
    updateProductTypeId = resolved;
  }

  const current = await prisma.trainingData.findUnique({
    where: { trainingTitle: decodedTitle },
    select: { trainingType: true, isLegacy: true, replacedBy: true },
  });
  if (!current) {
    return NextResponse.json({ error: "Training not found" }, { status: 404 });
  }
  const effectiveType: string = (isTrainingType(body.trainingType) ? body.trainingType : undefined)
    ?? current.trainingType;

  // Resolve legacy fields when supplied, or when the type changes to something
  // that can't be legacy (drop stale markers). Sanitised against the TARGET
  // title so a rename cannot leave the row naming itself as its own
  // replacement.
  let legacyUpdate: { isLegacy: boolean; replacedBy: string[] } | undefined;
  if (body.isLegacy !== undefined || body.replacedBy !== undefined) {
    legacyUpdate = await sanitizeLegacyFields(
      targetTitle,
      effectiveType,
      body.isLegacy !== undefined ? body.isLegacy : current.isLegacy,
      body.replacedBy !== undefined ? body.replacedBy : current.replacedBy,
    );
  } else if (body.trainingType !== undefined && !isLegacyEligible(body.trainingType)) {
    legacyUpdate = { isLegacy: false, replacedBy: [] };
  } else if (renaming && current.isLegacy) {
    // The row's own replacement list is keyed on training titles, so a rename
    // has to re-sanitise it even when the request says nothing about legacy.
    legacyUpdate = await sanitizeLegacyFields(
      targetTitle,
      effectiveType,
      current.isLegacy,
      current.replacedBy,
    );
  }

  // An OLX sub-item may never carry a certification, matching every other write
  // path. Keyed on the EFFECTIVE type rather than on the request's, so changing
  // a row's type to OLXSubItem clears a stale list instead of leaving one
  // behind that no consumer would ever read.
  const certificationUpdate: string[] | undefined =
    effectiveType === "OLXSubItem"
      ? []
      : body.certification !== undefined
        ? (Array.isArray(body.certification) ? body.certification : [])
        : undefined;

  const { training, affectedParents } = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    // The key move first, so everything after addresses the row by its new
    // name. Prisma emits a plain UPDATE here, which is what fires the cascade.
    if (renaming) {
      await tx.trainingData.update({
        where: { trainingTitle: decodedTitle },
        data: { trainingTitle: targetTitle },
      });
      // `certification[]` and `replacedBy[]` on OTHER rows are bare String[]
      // columns with no foreign key, so the cascade does not reach them.
      await rewriteTitleReferences(tx, decodedTitle, targetTitle);
    }

    const updated = await tx.trainingData.update({
      where: { trainingTitle: targetTitle },
      data: {
        ...(body.fullTitle && { fullTitle: body.fullTitle }),
        ...(body.trainingType && {
          trainingType: body.trainingType as TrainingType,
        }),
        ...(updateProductTypeId !== undefined && {
          productTypeId: updateProductTypeId,
        }),
        ...(body.function && { function: body.function as FunctionType }),
        ...(body.link !== undefined && { link: safeExternalUrl(body.link) }),
        ...(certificationUpdate !== undefined && { certification: certificationUpdate }),
        ...(legacyUpdate !== undefined && {
          isLegacy: legacyUpdate.isLegacy,
          replacedBy: legacyUpdate.replacedBy,
        }),
        // Guarded above: only reachable with all three fields supplied.
        ...(completing && { isIncomplete: false }),
        // Explicit boolean check, not truthiness: `false` means restore, and a
        // truthiness guard would silently drop it.
        ...(typeof body.isIgnored === "boolean" && { isIgnored: body.isIgnored }),
      },
    });
    const sync = await syncMemberships(tx, targetTitle, updated.trainingType, subItems, parents);
    // A rename moves the OLX relations with it, so the parent's materialised
    // completions have to be recomputed under the new key too.
    const affected = new Set(sync.affectedParents);
    if (renaming) affected.add(targetTitle);
    return { training: updated, affectedParents: [...affected] };
  });

  for (const p of affectedParents) {
    await recomputeAllStudentsForParent(p);
  }

  invalidateReportCache();
  return NextResponse.json(training);
}

// There is deliberately no PATCH here. It used to be a bodyless
// "flip isIncomplete to false" that the old "Mark as Complete" button called
// without the admin ever opening the editor, which promoted the import's
// placeholder type/product/function into the catalogue as if they had been
// chosen. Completion now runs through PUT, which supplies the real values and
// validates them together — see the completion gate there.

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ title: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }
  const { title } = await params;
  const decodedTitleMaybe = safeDecodeParam(title);
  if (decodedTitleMaybe === null) {
    return NextResponse.json({ error: "Invalid title parameter" }, { status: 400 });
  }
  const decodedTitle = decodedTitleMaybe;

  // Find any parent OLX rows that included this title as a sub-item, so we
  // can recompute them after the cascade delete.
  const memberships = await prisma.olxSubItemRelation.findMany({
    where: { subItemTrainingTitle: decodedTitle },
    select: { parentTrainingTitle: true },
  });
  const affectedParents = memberships.map((m) => m.parentTrainingTitle);

  // The delete and the reference scrub are one unit: `certification[]` and
  // `replacedBy[]` hold this title as a plain string with no FK, so the cascade
  // does not reach them and a half-applied pair would leave a dangling key
  // behind with the row already gone.
  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    await tx.trainingData.delete({ where: { trainingTitle: decodedTitle } });
    await rewriteTitleReferences(tx, decodedTitle, null);
  });

  for (const p of affectedParents) {
    await recomputeAllStudentsForParent(p);
  }

  invalidateReportCache();
  return NextResponse.json({ success: true });
}
