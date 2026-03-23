import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  // Find all ILT trainings that have a certification mapping
  const iltWithCert = await prisma.trainingData.findMany({
    where: {
      trainingType: "InstructorLedTraining",
      certification: { not: null },
    },
  });

  if (iltWithCert.length === 0) {
    return NextResponse.json([]);
  }

  // Build a map: ILT trainingTitle -> certification trainingTitle
  // Also collect all certification titles we need to look up
  const certTitles = new Set<string>();
  for (const ilt of iltWithCert) {
    if (ilt.certification) certTitles.add(ilt.certification);
  }

  // Get full title info for certifications
  const certData = await prisma.trainingData.findMany({
    where: { trainingTitle: { in: Array.from(certTitles) } },
  });
  const certFullTitleMap = new Map(certData.map((c) => [c.trainingTitle, c.fullTitle]));

  // Get full title info for ILTs
  const iltFullTitleMap = new Map(iltWithCert.map((i) => [i.trainingTitle, i.fullTitle]));

  // For each ILT, find students who completed it but NOT the associated certification
  const results: {
    fullName: string;
    email: string;
    theatre: string;
    region: string;
    country: string;
    iltFullTitle: string;
    certificationFullTitle: string;
  }[] = [];

  for (const ilt of iltWithCert) {
    if (!ilt.certification) continue;

    // Students who completed this ILT
    const iltStudents = await prisma.trainingTaken.findMany({
      where: { trainingTitle: ilt.trainingTitle },
      select: { email: true },
      distinct: ["email"],
    });

    if (iltStudents.length === 0) continue;

    const iltEmails = iltStudents.map((s) => s.email);

    // Students who completed the associated certification
    const certStudents = await prisma.trainingTaken.findMany({
      where: {
        trainingTitle: ilt.certification,
        email: { in: iltEmails },
      },
      select: { email: true },
      distinct: ["email"],
    });

    const certifiedEmails = new Set(certStudents.map((s) => s.email));
    const uncertifiedEmails = iltEmails.filter((e) => !certifiedEmails.has(e));

    if (uncertifiedEmails.length === 0) continue;

    // Get student details
    const students = await prisma.student.findMany({
      where: { email: { in: uncertifiedEmails } },
      include: { regionData: true },
    });

    const iltFull = iltFullTitleMap.get(ilt.trainingTitle) || ilt.trainingTitle;
    const certFull = certFullTitleMap.get(ilt.certification) || ilt.certification;

    for (const student of students) {
      results.push({
        fullName: student.fullName,
        email: student.email,
        theatre: student.theatre,
        region: student.regionData?.region || "",
        country: student.country,
        iltFullTitle: iltFull,
        certificationFullTitle: certFull,
      });
    }
  }

  // Sort by fullName
  results.sort((a, b) => a.fullName.localeCompare(b.fullName));

  return NextResponse.json(results);
}
