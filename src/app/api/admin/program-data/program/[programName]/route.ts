import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { safeDecodeParam } from "@/lib/utils";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";
import {
  parseIncludedTheatres,
  parseProgramDescription,
  parseProgramMinimums,
  unknownTheatres,
} from "@/lib/program-data-write";

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
 *  - countrySetMinimumCountries / targetMinimumCountries: the program's default
 *    minimum countries for the By Country Set view and the By Theatre view
 *    (target countries). Each 1–1000, or null/"" to clear; an absent key
 *    leaves the stored value alone.
 *  - includedTheatres: the theatres the program operates in, as a list of
 *    Region Data theatre names; [] or null = every theatre. An absent key
 *    leaves it alone; an unknown theatre is a 400 naming it.
 *  - description: free text (≤ 2000 characters); null or "" clears it, an
 *    absent key leaves it alone.
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
  const minimums = parseProgramMinimums(body);
  if (!minimums.ok) {
    return NextResponse.json({ error: minimums.error }, { status: 400 });
  }
  let includedTheatres: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "includedTheatres")) {
    const theatres = parseIncludedTheatres(body.includedTheatres);
    if (!theatres.ok) return NextResponse.json({ error: theatres.error }, { status: 400 });
    const unknown = await unknownTheatres(theatres.value);
    if (unknown.length > 0) {
      return NextResponse.json({ error: `Unknown theatre: ${unknown.join(", ")}` }, { status: 400 });
    }
    includedTheatres = theatres.value;
  }

  let description: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    const parsedDescription = parseProgramDescription(body.description);
    if (!parsedDescription.ok) return NextResponse.json({ error: parsedDescription.error }, { status: 400 });
    description = parsedDescription.value;
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
      countrySetMinimumCountries?: number | null;
      targetMinimumCountries?: number | null;
      includedTheatres?: string[];
      description?: string | null;
    } = {};
    if (description !== undefined) settings.description = description;
    if (includedTheatres !== undefined) settings.includedTheatres = includedTheatres;
    if (hasIsTiered) settings.isTiered = body.isTiered as boolean;
    if (hasDeploymentMode) settings.deploymentMode = deploymentMode;
    if (minimums.value.countrySetMinimumCountries !== undefined) {
      settings.countrySetMinimumCountries = minimums.value.countrySetMinimumCountries;
    }
    if (minimums.value.targetMinimumCountries !== undefined) {
      settings.targetMinimumCountries = minimums.value.targetMinimumCountries;
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
    select: {
      countrySetMinimumCountries: true,
      targetMinimumCountries: true,
      includedTheatres: true,
      description: true,
    },
  });
  return NextResponse.json({
    success: true,
    updated,
    countrySetMinimumCountries: after?.countrySetMinimumCountries ?? null,
    targetMinimumCountries: after?.targetMinimumCountries ?? null,
    includedTheatres: after?.includedTheatres ?? [],
    description: after?.description ?? null,
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
