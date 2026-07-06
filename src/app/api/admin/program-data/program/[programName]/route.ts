import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { safeDecodeParam } from "@/lib/utils";

/**
 * PATCH /api/admin/program-data/program/[programName]
 * Updates a program. Body may carry:
 *  - newName: rename the program (updates the registry Program row, cascades to
 *    program_tiers via the FK, and updates every ProgramData row sharing the
 *    old name).
 *  - isTiered / deploymentMode: tier configuration flags.
 * Any subset may be provided; a settings-only PATCH omits newName.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ programName: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { programName } = await params;
  const oldName = safeDecodeParam(programName);
  if (oldName === null) {
    return NextResponse.json({ error: "Invalid program name" }, { status: 400 });
  }

  const body = await request.json();
  const rawNewName = typeof body?.newName === "string" ? body.newName.trim() : "";
  const wantsRename = rawNewName !== "" && rawNewName !== oldName;
  const hasIsTiered = typeof body?.isTiered === "boolean";
  const hasDeploymentMode = typeof body?.deploymentMode === "string";
  const DEPLOYMENT_MODES = ["flat", "perAchievedSpecialisation", "perTierPerSpecialisation"];
  const deploymentMode = DEPLOYMENT_MODES.includes(body?.deploymentMode) ? body.deploymentMode : "flat";

  // Existence check: the program must exist either in the registry or as rows.
  const [existingProgram, existingRows] = await Promise.all([
    prisma.program.findUnique({ where: { name: oldName } }),
    prisma.programData.count({ where: { programName: oldName } }),
  ]);
  if (!existingProgram && existingRows === 0) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }

  if (wantsRename) {
    // Collision check against both the registry and existing requirements.
    const [collideProgram, collideRows] = await Promise.all([
      prisma.program.findUnique({ where: { name: rawNewName } }),
      prisma.programData.count({ where: { programName: rawNewName } }),
    ]);
    if (collideProgram || collideRows > 0) {
      return NextResponse.json({ error: "A program with this name already exists" }, { status: 409 });
    }
  }

  const finalName = wantsRename ? rawNewName : oldName;

  const updated = await prisma.$transaction(async (tx) => {
    const settings: { isTiered?: boolean; deploymentMode?: string } = {};
    if (hasIsTiered) settings.isTiered = body.isTiered;
    if (hasDeploymentMode) settings.deploymentMode = deploymentMode;

    if (existingProgram) {
      await tx.program.update({
        where: { name: oldName },
        data: { ...(wantsRename ? { name: rawNewName } : {}), ...settings },
      });
    } else {
      // Registry row missing (legacy data) — create it under the final name.
      await tx.program.create({ data: { name: finalName, ...settings } });
    }
    if (wantsRename) {
      const res = await tx.programData.updateMany({
        where: { programName: oldName },
        data: { programName: rawNewName },
      });
      // program_tiers.programName cascades via the FK's ON UPDATE CASCADE.
      return res.count;
    }
    return 0;
  });

  return NextResponse.json({ success: true, updated });
}

/**
 * DELETE /api/admin/program-data/program/[programName]
 * Deletes a program and all of its requirements (alternatives cascade via the
 * ProgramDataAlternative FK), then removes the registry row.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ programName: string }> }
) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const { programName } = await params;
  const name = safeDecodeParam(programName);
  if (name === null) {
    return NextResponse.json({ error: "Invalid program name" }, { status: 400 });
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const res = await tx.programData.deleteMany({ where: { programName: name } });
    await tx.program.deleteMany({ where: { name } });
    return res.count;
  });

  return NextResponse.json({ success: true, deleted });
}
