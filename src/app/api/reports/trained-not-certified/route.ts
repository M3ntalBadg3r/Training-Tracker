import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  // Find all ILT trainings that have at least one certification mapping
  const iltWithCert = await prisma.trainingData.findMany({
    where: {
      trainingType: "InstructorLedTraining",
      certification: { isEmpty: false },
    },
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
  const certFullTitleMap = new Map(certData.map((c) => [c.trainingTitle, c.fullTitle]));

  // For each ILT + certification pair, find students who completed
  // the ILT but NOT that specific certification
  const results: {
    fullName: string;
    email: string;
    theatre: string;
    region: string;
    country: string;
    iltFullTitle: string;
    certificationFullTitle: string;
    iltCompletedDate: string;
    iltActive: boolean;
  }[] = [];

  const now = new Date();

  for (const ilt of iltWithCert) {
    if (ilt.certification.length === 0) continue;

    // Students who completed this ILT (include dates for the report)
    const iltRecords = await prisma.trainingTaken.findMany({
      where: { trainingTitle: ilt.trainingTitle },
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

    // Check each certification mapped to this ILT
    for (const certTitle of ilt.certification) {
      const certStudents = await prisma.trainingTaken.findMany({
        where: {
          trainingTitle: certTitle,
          email: { in: iltEmails },
        },
        select: { email: true },
        distinct: ["email"],
      });

      const certifiedEmails = new Set(certStudents.map((s) => s.email));
      const uncertifiedEmails = iltEmails.filter((e) => !certifiedEmails.has(e));

      if (uncertifiedEmails.length === 0) continue;

      const students = await prisma.student.findMany({
        where: { email: { in: uncertifiedEmails } },
        include: { regionData: true },
      });

      const iltFull = ilt.fullTitle;
      const certFull = certFullTitleMap.get(certTitle) || certTitle;

      for (const student of students) {
        const iltRecord = iltByEmail.get(student.email)!;
        results.push({
          fullName: student.fullName,
          email: student.email,
          theatre: student.theatre,
          region: student.regionData?.region || "",
          country: student.country,
          iltFullTitle: iltFull,
          certificationFullTitle: certFull,
          iltCompletedDate: iltRecord.completedDate.toISOString(),
          iltActive: iltRecord.expiryDate > now,
        });
      }
    }
  }

  // Sort by fullName
  results.sort((a, b) => a.fullName.localeCompare(b.fullName));

  return NextResponse.json(results);
}
