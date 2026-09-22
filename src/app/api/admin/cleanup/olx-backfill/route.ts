import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, handleAuthError } from "@/lib/auth";
import { recomputeAllStudentsForParent, scanOlxParentState } from "@/lib/olx";
import { dedupeTitles } from "@/lib/training-group";
import { invalidateReportCache } from "@/lib/report-cache";
import { readJsonBody } from "@/lib/request-body";

/** Bound one request: the scan is the source of the list, not a free-text field. */
const MAX_PARENTS = 500;

/**
 * POST — reconcile named OLX parents against the completion rule.
 *
 * Body: `{ parentTrainingTitles: string[] }`, taken from the Catalogue Integrity
 * scan. Required and bounded rather than "recompute everything", so the write is
 * as wide as the admin could actually see before pressing the button.
 *
 * It calls the existing `recomputeAllStudentsForParent` and adds no rule of its
 * own. That matters more than it looks: the rule both materialises a row when a
 * learner satisfies it and REMOVES one when they do not, so a second
 * implementation here would be a second opinion about whose completions are
 * real. The scan reports both directions from the same grouping helper, which is
 * why there is no separate `?dryRun=` — a dry run would be that second
 * implementation.
 */
export async function POST(request: NextRequest) {
  try {
    await requireSuperAdmin(request);
  } catch (error) {
    return handleAuthError(error);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body as { parentTrainingTitles?: unknown };

  if (!Array.isArray(body?.parentTrainingTitles)) {
    return NextResponse.json(
      { error: "parentTrainingTitles must be an array of training titles" },
      { status: 400 },
    );
  }

  const parents = dedupeTitles(body.parentTrainingTitles);
  if (parents.length === 0) {
    return NextResponse.json(
      { error: "parentTrainingTitles must name at least one training" },
      { status: 400 },
    );
  }
  if (parents.length > MAX_PARENTS) {
    return NextResponse.json(
      { error: `At most ${MAX_PARENTS} parents can be reconciled in one request` },
      { status: 400 },
    );
  }

  // Two extra scans to report honestly what changed. The alternative — having
  // `recomputeAllStudentsForParent` return counts — would change a signature six
  // other call sites depend on, to serve one admin-triggered action that runs
  // rarely and is never on a hot path. The scan is bounded by the OLX catalogue,
  // not by the whole training set.
  const before = await scanOlxParentState();

  for (const parent of parents) {
    // A title that is missing, or is not an OLX, returns early inside the
    // helper — so an out-of-date list from a stale scan is a no-op, not an error.
    await recomputeAllStudentsForParent(parent);
  }

  const after = await scanOlxParentState();
  invalidateReportCache();

  const requested = new Set(parents);
  const countFor = (
    rows: { email: string; parentTrainingTitle: string }[],
  ): number => rows.filter((r) => requested.has(r.parentTrainingTitle)).length;

  return NextResponse.json({
    parentsProcessed: parents.length,
    completionsAdded: countFor(before.owed) - countFor(after.owed),
    completionsRemoved: countFor(before.unsupported) - countFor(after.unsupported),
    remainingOwed: countFor(after.owed),
    remainingUnsupported: countFor(after.unsupported),
  });
}
