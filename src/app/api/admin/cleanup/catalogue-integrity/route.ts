import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { scanOlxParentState } from "@/lib/olx";
import { scanDanglingReferences, scanLeadsToUneven } from "@/lib/catalogue-integrity";

/**
 * GET — the Catalogue Integrity scan behind `/admin/cleanup`.
 *
 * Read-only, and deliberately so: it is the preview the admin reads before
 * running either of the two fixes next to it, so it must never be the thing that
 * changes what it is reporting on.
 *
 * Global reference data (the catalogue) plus completion rows across every
 * tenant, so it is SuperAdmin-only like the rest of `/admin/cleanup` — there is
 * no company-scoped view of this that would mean anything.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const [olx, dangling, leadsToUneven] = await Promise.all([
    scanOlxParentState(),
    scanDanglingReferences(),
    scanLeadsToUneven(),
  ]);

  // Learner names for the rows we are actually returning, rather than for every
  // email the scan touched.
  const emails = [
    ...new Set([...olx.owed, ...olx.unsupported].map((r) => r.email)),
  ];
  const students = emails.length === 0
    ? []
    : await prisma.student.findMany({
        where: { email: { in: emails } },
        select: { email: true, fullName: true },
      });
  const nameOf = new Map(students.map((s) => [s.email, s.fullName]));
  const withName = <T extends { email: string }>(row: T) => ({
    ...row,
    fullName: nameOf.get(row.email) ?? "",
  });

  return NextResponse.json({
    olxOwed: olx.owed.map(withName),
    olxUnsupported: olx.unsupported.map(withName),
    danglingCertification: dangling.certification,
    danglingReplacedBy: dangling.replacedBy,
    leadsToUneven,
  });
}
