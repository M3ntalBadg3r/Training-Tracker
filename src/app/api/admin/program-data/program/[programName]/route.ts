import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { safeDecodeParam } from "@/lib/utils";

/**
 * PATCH /api/admin/program-data/program/[programName]
 * Renames a program: updates the registry Program row and every ProgramData
 * requirement sharing the old name. Body: { newName }.
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
  const newName = typeof body?.newName === "string" ? body.newName.trim() : "";
  if (!newName) {
    return NextResponse.json({ error: "Program name is required" }, { status: 400 });
  }
  if (newName === oldName) {
    return NextResponse.json({ success: true, updated: 0 });
  }

  // Collision check against both the registry and existing requirements.
  const [collideProgram, collideRows] = await Promise.all([
    prisma.program.findUnique({ where: { name: newName } }),
    prisma.programData.count({ where: { programName: newName } }),
  ]);
  if (collideProgram || collideRows > 0) {
    return NextResponse.json({ error: "A program with this name already exists" }, { status: 409 });
  }

  // Existence check: the program must exist either in the registry or as rows.
  const [existingProgram, existingRows] = await Promise.all([
    prisma.program.findUnique({ where: { name: oldName } }),
    prisma.programData.count({ where: { programName: oldName } }),
  ]);
  if (!existingProgram && existingRows === 0) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (existingProgram) {
      await tx.program.update({ where: { name: oldName }, data: { name: newName } });
    } else {
      // Registry row missing (legacy data) — create it under the new name.
      await tx.program.create({ data: { name: newName } });
    }
    const res = await tx.programData.updateMany({
      where: { programName: oldName },
      data: { programName: newName },
    });
    return res.count;
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
