import { NextRequest, NextResponse } from "next/server";
import prisma, { type PrismaTransactionClient } from "@/lib/prisma";
import { TrainingType, ProductType, FunctionType } from "@prisma/client";
import { handleAuthError, requireSuperAdmin } from "@/lib/auth";
import { recomputeAllStudentsForParent } from "@/lib/olx";
import { safeDecodeParam } from "@/lib/utils";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ title: string }> }
) {
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

async function syncMemberships(
  tx: PrismaTransactionClient,
  trainingTitle: string,
  trainingType: string,
  subItems: string[] | undefined,
  parents: string[] | undefined,
): Promise<{ affectedParents: string[] }> {
  const affectedParents = new Set<string>();

  if (trainingType === "OLX" && subItems) {
    const desired = new Set(subItems);
    const existing = await tx.olxSubItemRelation.findMany({
      where: { parentTrainingTitle: trainingTitle },
      select: { subItemTrainingTitle: true },
    });
    const existingSet = new Set(existing.map((e) => e.subItemTrainingTitle));
    const toAdd = [...desired].filter((s) => !existingSet.has(s));
    const toRemove = [...existingSet].filter((s) => !desired.has(s));
    if (toRemove.length > 0) {
      await tx.olxSubItemRelation.deleteMany({
        where: { parentTrainingTitle: trainingTitle, subItemTrainingTitle: { in: toRemove } },
      });
    }
    if (toAdd.length > 0) {
      await tx.olxSubItemRelation.createMany({
        data: toAdd.map((s) => ({ parentTrainingTitle: trainingTitle, subItemTrainingTitle: s })),
      });
    }
    if (toAdd.length > 0 || toRemove.length > 0) {
      affectedParents.add(trainingTitle);
    }
  } else if (trainingType !== "OLX") {
    // Not (or no longer) an OLX parent — drop any parent-side relations.
    const existing = await tx.olxSubItemRelation.findMany({
      where: { parentTrainingTitle: trainingTitle },
      select: { subItemTrainingTitle: true },
    });
    if (existing.length > 0) {
      await tx.olxSubItemRelation.deleteMany({
        where: { parentTrainingTitle: trainingTitle },
      });
      affectedParents.add(trainingTitle);
    }
  }

  if (trainingType === "OLXSubItem" && parents) {
    const desired = new Set(parents);
    const existing = await tx.olxSubItemRelation.findMany({
      where: { subItemTrainingTitle: trainingTitle },
      select: { parentTrainingTitle: true },
    });
    const existingSet = new Set(existing.map((e) => e.parentTrainingTitle));
    const toAdd = [...desired].filter((p) => !existingSet.has(p));
    const toRemove = [...existingSet].filter((p) => !desired.has(p));
    if (toRemove.length > 0) {
      await tx.olxSubItemRelation.deleteMany({
        where: { subItemTrainingTitle: trainingTitle, parentTrainingTitle: { in: toRemove } },
      });
      for (const p of toRemove) affectedParents.add(p);
    }
    if (toAdd.length > 0) {
      await tx.olxSubItemRelation.createMany({
        data: toAdd.map((p) => ({ parentTrainingTitle: p, subItemTrainingTitle: trainingTitle })),
      });
      for (const p of toAdd) affectedParents.add(p);
    }
  } else if (trainingType !== "OLXSubItem") {
    // Not (or no longer) an OLX sub-item — drop sub-item-side relations.
    const existing = await tx.olxSubItemRelation.findMany({
      where: { subItemTrainingTitle: trainingTitle },
      select: { parentTrainingTitle: true },
    });
    if (existing.length > 0) {
      await tx.olxSubItemRelation.deleteMany({
        where: { subItemTrainingTitle: trainingTitle },
      });
      for (const e of existing) affectedParents.add(e.parentTrainingTitle);
    }
  }

  return { affectedParents: [...affectedParents] };
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

  const newTitle = body.trainingTitle?.trim();
  const subItems = body.subItems !== undefined ? dedupeStrings(body.subItems) : undefined;
  const parents = body.parents !== undefined ? dedupeStrings(body.parents) : undefined;

  // If trainingTitle changed, need to delete + recreate since it's the PK
  if (newTitle && newTitle !== decodedTitle) {
    const existing = await prisma.trainingData.findUnique({
      where: { trainingTitle: newTitle },
    });
    if (existing) {
      return NextResponse.json(
        { error: `Training title "${newTitle}" already exists` },
        { status: 409 }
      );
    }

    const { training, affectedParents } = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
      // Update all references in training_taken
      await tx.trainingTaken.updateMany({
        where: { trainingTitle: decodedTitle },
        data: { trainingTitle: newTitle },
      });
      // Update relation tables (cascade-on-update would also work, but be explicit).
      await tx.olxSubItemRelation.updateMany({
        where: { parentTrainingTitle: decodedTitle },
        data: { parentTrainingTitle: newTitle },
      });
      await tx.olxSubItemRelation.updateMany({
        where: { subItemTrainingTitle: decodedTitle },
        data: { subItemTrainingTitle: newTitle },
      });
      const old = await tx.trainingData.findUnique({
        where: { trainingTitle: decodedTitle },
      });
      await tx.trainingData.delete({ where: { trainingTitle: decodedTitle } });
      const trainingType = (body.trainingType as TrainingType) ?? old?.trainingType ?? "Certification";
      const created = await tx.trainingData.create({
        data: {
          trainingTitle: newTitle,
          fullTitle: body.fullTitle ?? old?.fullTitle ?? "",
          trainingType,
          productType: (body.productType as ProductType) ?? old?.productType ?? "Cortex",
          function: (body.function as FunctionType) ?? old?.function ?? "Sales",
          link: body.link !== undefined ? body.link || null : old?.link ?? null,
          certification: trainingType === "OLXSubItem"
            ? []
            : (body.certification !== undefined
                ? (Array.isArray(body.certification) ? body.certification : [])
                : (old?.certification ?? [])),
        },
      });
      const sync = await syncMemberships(tx, newTitle, trainingType, subItems, parents);
      return { training: created, affectedParents: sync.affectedParents };
    });

    for (const p of affectedParents) {
      await recomputeAllStudentsForParent(p);
    }

    return NextResponse.json(training);
  }

  const { training, affectedParents } = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    const updated = await tx.trainingData.update({
      where: { trainingTitle: decodedTitle },
      data: {
        ...(body.fullTitle && { fullTitle: body.fullTitle }),
        ...(body.trainingType && {
          trainingType: body.trainingType as TrainingType,
        }),
        ...(body.productType && {
          productType: body.productType as ProductType,
        }),
        ...(body.function && { function: body.function as FunctionType }),
        ...(body.link !== undefined && { link: body.link || null }),
        ...(body.certification !== undefined && {
          certification: body.trainingType === "OLXSubItem"
            ? []
            : (Array.isArray(body.certification) ? body.certification : []),
        }),
      },
    });
    const sync = await syncMemberships(tx, decodedTitle, updated.trainingType, subItems, parents);
    return { training: updated, affectedParents: sync.affectedParents };
  });

  for (const p of affectedParents) {
    await recomputeAllStudentsForParent(p);
  }

  return NextResponse.json(training);
}

export async function PATCH(
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

  const training = await prisma.trainingData.update({
    where: { trainingTitle: decodedTitle },
    data: { isIncomplete: false },
  });

  return NextResponse.json(training);
}

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

  await prisma.trainingData.delete({
    where: { trainingTitle: decodedTitle },
  });

  for (const p of affectedParents) {
    await recomputeAllStudentsForParent(p);
  }

  return NextResponse.json({ success: true });
}
