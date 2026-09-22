import { NextRequest, NextResponse } from "next/server";
import { TrainingType } from "@prisma/client";
import { handleAuthError, requireAuth } from "@/lib/auth";
import { isTrainingType, listFullTitleOptions } from "@/lib/training-group";

/**
 * GET — the option list for every Full Title picker.
 *
 * `?types=Certification,OLX` narrows it; an unknown type is ignored rather than
 * rejected, so a stale client cannot 400 the whole list.
 *
 * This exists so the admin pages stop fetching `/api/training-data/all` — the
 * entire catalogue, every row — purely to build a dropdown out of it.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const raw = request.nextUrl.searchParams.get("types");
  const types: TrainingType[] = raw
    ? raw.split(",").map((t) => t.trim()).filter(isTrainingType)
    : [];

  const options = await listFullTitleOptions(types.length > 0 ? { types } : {});
  return NextResponse.json(options);
}
