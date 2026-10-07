import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";

/**
 * One row per training completion, in the student import's own column shape,
 * so the file the Student Data page builds from this can be imported straight
 * back — on this system or another.
 *
 * Two rules keep that round trip honest:
 *
 * - **Materialised OLX parent rows are left out.** A parent OLX with sub-items
 *   is completed by the system once every sub-item is held (`lib/olx.ts`), and
 *   imports must never write that row directly. The sub-item rows that ARE
 *   exported rebuild it on re-import. A single-item OLX (no sub-items) is an
 *   ordinary completion and is included.
 * - **Dates are ISO `yyyy-mm-dd`.** ISO cells never vote in the import's
 *   day/month format detection and parse identically whichever date format the
 *   receiving system is set to.
 *
 * Students with no completions do not appear: the import needs a training and
 * a completed date on every row, so such a row could not be re-imported.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request, "Admin");
  } catch (error) {
    return handleAuthError(error);
  }

  const { searchParams } = new URL(request.url);
  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  try {
    const records = await prisma.trainingTaken.findMany({
      where: {
        // `[]` is truthy, so an empty scope would still match nothing here.
        ...(companyFilter ? { student: { companyId: { in: companyFilter } } } : {}),
        trainingData: {
          NOT: { trainingType: "OLX", subItemMemberships: { some: {} } },
        },
      },
      select: {
        trainingTitle: true,
        completedDate: true,
        expiryDate: true,
        student: {
          select: {
            fullName: true,
            email: true,
            country: true,
            theatre: true,
            company: { select: { name: true } },
          },
        },
        trainingData: { select: { fullTitle: true, trainingType: true } },
      },
      orderBy: [{ email: "asc" }, { completedDate: "asc" }, { trainingTitle: "asc" }],
    });

    const isoDate = (d: Date) => d.toISOString().slice(0, 10);
    const rows = records.map((r) => ({
      fullName: r.student.fullName,
      email: r.student.email,
      company: r.student.company.name,
      country: r.student.country,
      theatre: r.student.theatre,
      title: r.trainingTitle,
      completedDate: isoDate(r.completedDate),
      fullTitle: r.trainingData.fullTitle,
      trainingType: r.trainingData.trainingType,
      expiryDate: isoDate(r.expiryDate),
    }));

    return NextResponse.json({ rows });
  } catch (error) {
    console.warn("Student data export failed:", error);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
