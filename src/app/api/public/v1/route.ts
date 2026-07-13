import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { handleAuthError } from "@/lib/auth";
import {
  requireApiKey,
  checkApiKeyRateLimit,
  checkInvalidApiKeyRateLimit,
  extractPresentedKey,
} from "@/lib/api-key";
import { getClientIp } from "@/lib/rate-limit";
import { recordApiFailure } from "@/lib/failed-attempts";

/**
 * GET /api/public/v1 — self-describing index. Confirms the key works and reports
 * which companies it can read plus the available read-only endpoints.
 */
export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await requireApiKey(request);
  } catch (error) {
    const ip = getClientIp(request);
    const withinBudget = await checkInvalidApiKeyRateLimit(ip);
    if (!withinBudget) {
      return NextResponse.json(
        { error: "Too many invalid API key attempts. Please try again later." },
        { status: 429 }
      );
    }
    const presented = extractPresentedKey(request);
    if (presented) await recordApiFailure({ presentedKey: presented, ip });
    return handleAuthError(error);
  }
  if (!(await checkApiKeyRateLimit(auth.apiKeyId))) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please slow down." },
      { status: 429 }
    );
  }

  const companies = await prisma.company.findMany({
    where: { id: { in: auth.companyIds } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    name: "Training Tracker Public API",
    version: "v1",
    keyName: auth.name,
    companies,
    endpoints: [
      { method: "GET", path: "/api/public/v1/students", description: "Student roster" },
      { method: "GET", path: "/api/public/v1/training-records", description: "Per-completion training records" },
      {
        method: "GET",
        path: "/api/public/v1/offerings",
        description:
          "Offering definitions (specialisations + supporting trainings). Add ?country= or ?region= for Onshore/Offshore compliance; ?name= for one offering.",
      },
      { method: "GET", path: "/api/public/v1/programs", description: "Partner program list (levels, per-theatre minimums, tiered flag)" },
      {
        method: "GET",
        path: "/api/public/v1/programs/{programName}",
        description:
          "Per-program compliance. ?level=country|region|theatre|global with ?country=/?region=/?theatre=; ?horizonMonths=3|6|12 for a forward projection; ?trainingTitle=&students=true for the holder roster.",
      },
      {
        method: "GET",
        path: "/api/public/v1/reports/{reportType}",
        description: "Report aggregates",
        reportTypes: [
          "trained-not-certified",
          "legacy-gap",
          "learner-scorecard",
          "by-product",
          "by-function",
          "expiring-soon",
          "currently-expired",
          "last-12-months",
        ],
      },
    ],
    notes: "All endpoints are read-only. Send the key as 'Authorization: Bearer <key>'. Use ?companyId= to scope to one of your companies.",
  });
}
