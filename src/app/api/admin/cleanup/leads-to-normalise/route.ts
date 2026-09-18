import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { normaliseLeadsTo } from "@/lib/catalogue-integrity";
import { CERT_BEARING_TYPES, isTrainingType } from "@/lib/training-group";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";

/** Bound one request: the scan is the source of the list. */
const MAX_GROUPS = 500;

/**
 * POST — level `certification[]` across the spellings of a Full Title group.
 *
 * Body: `{ groups: { fullTitle, trainingType }[] }`, from the Catalogue
 * Integrity scan. Each group gets the union of its members' current values
 * written to every member, so no spelling can lose a target it already had.
 *
 * See `lib/catalogue-integrity.ts:normaliseLeadsTo` for why this exists as a
 * route at all rather than being "open the page and press Save" — that path goes
 * through Full Titles and silently drops a target sharing the group's own Full
 * Title.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { groups?: unknown };

  if (!Array.isArray(body?.groups)) {
    return NextResponse.json(
      { error: "groups must be an array of { fullTitle, trainingType }" },
      { status: 400 },
    );
  }
  if (body.groups.length === 0) {
    return NextResponse.json(
      { error: "groups must name at least one training" },
      { status: 400 },
    );
  }
  if (body.groups.length > MAX_GROUPS) {
    return NextResponse.json(
      { error: `At most ${MAX_GROUPS} groups can be normalised in one request` },
      { status: 400 },
    );
  }

  const groups: { fullTitle: string; trainingType: (typeof CERT_BEARING_TYPES)[number] }[] = [];
  for (const raw of body.groups) {
    const fullTitle = typeof raw?.fullTitle === "string" ? raw.fullTitle.trim() : "";
    const trainingType = raw?.trainingType;
    if (!fullTitle) {
      return NextResponse.json({ error: "Each group needs a fullTitle" }, { status: 400 });
    }
    // Validated against the enum AND against the types this relationship means
    // something for — an unchecked cast here would be a Prisma 500 rather than a
    // 400, which is the same mistake `setFunction` used to make on this surface.
    if (!isTrainingType(trainingType) || !CERT_BEARING_TYPES.includes(trainingType)) {
      return NextResponse.json(
        { error: "trainingType must be an instructor-led training or OLX" },
        { status: 400 },
      );
    }
    groups.push({ fullTitle, trainingType });
  }

  const result = await normaliseLeadsTo(groups);
  if (result.rowsUpdated > 0) invalidateReportCache();

  return NextResponse.json(result);
}
