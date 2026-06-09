import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { FunctionType } from "@prisma/client";
import { handleAuthError, requireAuth, requireSuperAdmin } from "@/lib/auth";
import { recomputeAllStudentsForParent } from "@/lib/olx";
import { safeDecodeParam } from "@/lib/utils";
import { resolveProductTypeId } from "@/lib/product-types";
import { sanitizeLegacyFields } from "@/lib/legacy-training";

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

  return NextResponse.json({ fullTitle: decoded, members, meta });
}

/**
 * PATCH — bulk operations across every TrainingData row sharing `fullTitle`.
 * Body keys (all optional; applied in this order):
 *  - rename: string           → set a new fullTitle on every member
 *  - legacy: { isLegacy, replacedByFullTitles? }
 *      → for each Certification/Accreditation member, set isLegacy and expand
 *        the chosen replacement Full Titles to their underlying training titles.
 *  - setProductType: string   → apply a product type to every member
 *  - setFunction: string      → apply a function to every member
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
  const body = await request.json();

  const members = await prisma.trainingData.findMany({
    where: { fullTitle: decoded },
    select: { trainingTitle: true, trainingType: true },
  });
  if (members.length === 0) {
    return NextResponse.json({ error: "Full Title not found" }, { status: 404 });
  }

  // Resolve a target product type up-front (shared across all members).
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

  const rename = typeof body.rename === "string" ? body.rename.trim() : undefined;
  if (rename !== undefined && rename.length === 0) {
    return NextResponse.json({ error: "Full Title cannot be empty" }, { status: 400 });
  }

  // Expand replacement Full Titles → underlying training titles (validated later
  // by sanitizeLegacyFields, which keeps only existing Cert/Accred titles).
  let expandedReplacement: string[] | undefined;
  let isLegacyTarget: boolean | undefined;
  if (body.legacy && typeof body.legacy === "object") {
    isLegacyTarget = body.legacy.isLegacy === true;
    if (isLegacyTarget) {
      const replacementFulls: string[] = Array.isArray(body.legacy.replacedByFullTitles)
        ? body.legacy.replacedByFullTitles.filter(
            (x: unknown): x is string => typeof x === "string" && !!x.trim()
          )
        : [];
      if (replacementFulls.length > 0) {
        const repl = await prisma.trainingData.findMany({
          where: {
            fullTitle: { in: replacementFulls },
            trainingType: { in: LEGACY_ELIGIBLE_TYPES as ("Certification" | "Accreditation")[] },
          },
          select: { trainingTitle: true },
        });
        expandedReplacement = repl.map((r) => r.trainingTitle);
      } else {
        expandedReplacement = [];
      }
    } else {
      expandedReplacement = [];
    }
  }

  await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    // Field-level bulk updates (rename / product / function) — applied to all.
    const data: Record<string, unknown> = {};
    if (rename !== undefined) data.fullTitle = rename;
    if (productTypeId !== undefined) data.productTypeId = productTypeId;
    if (typeof body.setFunction === "string" && body.setFunction.trim()) {
      data.function = body.setFunction as FunctionType;
    }
    if (Object.keys(data).length > 0) {
      await tx.trainingData.updateMany({ where: { fullTitle: decoded }, data });
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

  await prisma.trainingData.deleteMany({ where: { fullTitle: decoded } });

  for (const p of affectedParents) {
    await recomputeAllStudentsForParent(p);
  }

  return NextResponse.json({ success: true });
}
