import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { safeDecodeParam } from "@/lib/utils";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";
import { anchoredLevelWarnings, parseAnchorSettings } from "@/lib/program-data-write";

/**
 * PATCH /api/admin/program-data/program/[programName]
 * Updates a program. Body may carry:
 *  - newName: rename the program (updates the registry Program row, cascades to
 *    program_tiers via the FK, and updates every ProgramData row sharing the
 *    old name).
 *  - isTiered / deploymentMode: tier configuration flags. Un-tiering a program
 *    that still has program-wide gates (rows with neither a specialisation
 *    nor a tier) is refused — those rows only mean something on a tiered
 *    program.
 *  - anchorTheatre (a Region Data theatre, or null/"" to clear) and
 *    defaultMinimumCountries (1–1000 or null). Anchoring a program that has
 *    rows at levels an anchored view never evaluates still succeeds, but the
 *    response's `warnings[]` names them.
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

  const parsed = await readJsonBody(request, 64 * 1024);
  if (!parsed.ok) return parsed.response;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const body = parsed.body as Record<string, unknown>;
  const rawNewName = typeof body.newName === "string" ? body.newName.trim() : "";
  const wantsRename = rawNewName !== "" && rawNewName !== oldName;
  const hasIsTiered = typeof body.isTiered === "boolean";
  const hasDeploymentMode = typeof body.deploymentMode === "string";
  const DEPLOYMENT_MODES = ["flat", "perAchievedSpecialisation", "perTierPerSpecialisation"];
  const deploymentMode =
    typeof body.deploymentMode === "string" && DEPLOYMENT_MODES.includes(body.deploymentMode)
      ? body.deploymentMode
      : "flat";
  const anchor = await parseAnchorSettings(body);
  if (!anchor.ok) {
    return NextResponse.json({ error: anchor.error }, { status: 400 });
  }

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

  if (hasIsTiered && body.isTiered === false && (existingProgram?.isTiered ?? false)) {
    const gates = await prisma.programData.count({
      where: { programName: oldName, specialisationId: null, tierId: null },
    });
    if (gates > 0) {
      return NextResponse.json(
        {
          error: `This program has ${gates} requirement${gates === 1 ? "" : "s"} required at every level — remove ${gates === 1 ? "it" : "them"} before making the program non-tiered`,
        },
        { status: 400 }
      );
    }
  }

  const finalName = wantsRename ? rawNewName : oldName;

  const updated = await prisma.$transaction(async (tx) => {
    const settings: {
      isTiered?: boolean;
      deploymentMode?: string;
      anchorTheatre?: string | null;
      defaultMinimumCountries?: number | null;
    } = {};
    if (hasIsTiered) settings.isTiered = body.isTiered as boolean;
    if (hasDeploymentMode) settings.deploymentMode = deploymentMode;
    if (anchor.value.anchorTheatre !== undefined) settings.anchorTheatre = anchor.value.anchorTheatre;
    if (anchor.value.defaultMinimumCountries !== undefined) {
      settings.defaultMinimumCountries = anchor.value.defaultMinimumCountries;
    }

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

  invalidateReportCache();

  const after = await prisma.program.findUnique({
    where: { name: finalName },
    select: { anchorTheatre: true, defaultMinimumCountries: true },
  });
  const anchorTheatre = after?.anchorTheatre?.trim() ? after.anchorTheatre.trim() : null;
  const warnings = await anchoredLevelWarnings(finalName, anchorTheatre);
  return NextResponse.json({
    success: true,
    updated,
    anchorTheatre,
    defaultMinimumCountries: after?.defaultMinimumCountries ?? null,
    warnings,
  });
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

  invalidateReportCache();
  return NextResponse.json({ success: true, deleted });
}
