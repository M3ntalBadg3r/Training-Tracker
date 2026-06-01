import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuth, handleAuthError } from "@/lib/auth";
import { getAuthorizedCompanyIds, resolveCompanyFilter } from "@/lib/company-scope";

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const allowed = await getAuthorizedCompanyIds(auth.sub, auth.role);
  const companyFilter = resolveCompanyFilter(allowed, request.nextUrl.searchParams.get("companyId"));
  if (companyFilter !== null && companyFilter.length === 0) return NextResponse.json([]);

  // Find all ILT and OLX trainings that have at least one certification
  // mapping. OLX parents are treated identically to ILT here — completion of
  // an OLX (all sub-items done) materialises a TrainingTaken row on the
  // parent, so the existing query logic works unchanged.
  const iltWithCert = await prisma.trainingData.findMany({
    where: {
      trainingType: { in: ["InstructorLedTraining", "OLX"] },
      certification: { isEmpty: false },
    },
    include: { productType: { select: { name: true } } },
  });

  if (iltWithCert.length === 0) {
    return NextResponse.json([]);
  }

  // Collect all certification titles we need to look up
  const certTitles = new Set<string>();
  for (const ilt of iltWithCert) {
    for (const cert of ilt.certification) {
      certTitles.add(cert);
    }
  }

  // Get full title info for certifications
  const certData = await prisma.trainingData.findMany({
    where: { trainingTitle: { in: Array.from(certTitles) } },
  });
  const certFullTitleMap = new Map(certData.map((c: typeof certData[number]) => [c.trainingTitle, c.fullTitle]));

  // For each ILT + certification pair, find students who completed
  // the ILT but NOT that specific certification
  const results: {
    fullName: string;
    email: string;
    theatre: string;
    region: string;
    country: string;
    iltFullTitle: string;
    iltProductType: string;
    certificationFullTitle: string;
    iltCompletedDate: string;
    iltActive: boolean;
  }[] = [];

  const now = new Date();

  for (const ilt of iltWithCert) {
    if (ilt.certification.length === 0) continue;

    // Students who completed this ILT (include dates for the report)
    const iltRecords = await prisma.trainingTaken.findMany({
      where: {
        trainingTitle: ilt.trainingTitle,
        ...(companyFilter ? { student: { companyId: { in: companyFilter } } } : {}),
      },
      select: { email: true, completedDate: true, expiryDate: true },
    });

    if (iltRecords.length === 0) continue;

    // Build a map of email -> most recent ILT record
    const iltByEmail = new Map<string, { completedDate: Date; expiryDate: Date }>();
    for (const rec of iltRecords) {
      const existing = iltByEmail.get(rec.email);
      if (!existing || rec.completedDate > existing.completedDate) {
        iltByEmail.set(rec.email, { completedDate: rec.completedDate, expiryDate: rec.expiryDate });
      }
    }

    const iltEmails = Array.from(iltByEmail.keys());

    // A training can map to multiple certifications (e.g. EDU-270 →
    // [XSIAM-Engineer, XSIAM-Select]). These are alternatives (OR): a student
    // is only "not certified" if they hold NONE of them. Query for students
    // holding ANY of the mapped certs and flag the rest.
    const certStudents = await prisma.trainingTaken.findMany({
      where: {
        trainingTitle: { in: ilt.certification },
        email: { in: iltEmails },
      },
      select: { email: true },
      distinct: ["email"],
    });

    const certifiedEmails = new Set(certStudents.map((s: typeof certStudents[number]) => s.email));
    const uncertifiedEmails = iltEmails.filter((e) => !certifiedEmails.has(e));

    if (uncertifiedEmails.length === 0) continue;

    const students = await prisma.student.findMany({
      where: { email: { in: uncertifiedEmails } },
      include: { regionData: true },
    });

    const iltFull = ilt.fullTitle;
    const iltProduct = ilt.productType.name;
    const certFull = ilt.certification.map((c: string) => certFullTitleMap.get(c) || c).join(" or ");

    for (const student of students) {
      const iltRecord = iltByEmail.get(student.email)!;
      results.push({
        fullName: student.fullName,
        email: student.email,
        theatre: student.theatre,
        region: student.regionData?.region || "",
        country: student.country,
        iltFullTitle: iltFull,
        iltProductType: iltProduct,
        certificationFullTitle: certFull,
        iltCompletedDate: iltRecord.completedDate.toISOString(),
        iltActive: iltRecord.expiryDate > now,
      });
    }
  }

  // Sort by fullName
  results.sort((a, b) => a.fullName.localeCompare(b.fullName));

  return NextResponse.json(results);
}
